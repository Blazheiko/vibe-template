import { createServer } from 'node:net'
import type { NormalizedEmail } from '#app/domain/email.js'

import { eq } from 'drizzle-orm'
import pg from 'pg'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Role } from 'shared/access'
import { hasPg } from '../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../../test-support/redis-test-client.js'
import { WsTestClient, type Frame } from '../../../test-support/ws-test-client.js'
import type { UserId } from '#app/domain/ids.js'

// feat-062 over real WebSocket connections: a real uWebSockets.js server with the real
// route tables, real sessions in Redis and real users in PostgreSQL. The role is
// changed the only way it can be changed in this application: in the database.

const getFreePort = () =>
    new Promise<number>((resolve, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address()
            probe.close(() => {
                resolve(typeof address === 'object' && address !== null ? address.port : 0)
            })
        })
    })

const PORT = await getFreePort()

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    // The bounded lookups (session check, admin role re-check) give up after this long.
    process.env['SESSION_TOKEN_CHECK_TIMEOUT_MS'] = '400'
    return { PREFIX: `test:${crypto.randomUUID()}:` }
})

const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))
vi.mock('#config/app.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return {
        default: {
            ...actual.default,
            host: '127.0.0.1',
            port: PORT,
            serveStatic: false,
            unixPath: undefined,
            pathPrefix: 'api',
        },
    }
})
vi.mock('#config/redis.js', async (importActual) => {
    const actual = await importActual<{ default: object }>()
    return { default: { ...actual.default, keyPrefix: PREFIX } }
})
vi.mock('#database/redis.js', async () => {
    const { Redis: Client } = await import('ioredis')
    const { mainRedisOptions } = await import('#database/redis-main-options.js')
    const { createRedisHealth, createWithRedis } = await import('#database/redis-health.js')
    const { host: _host, port: _port, ...contract } = mainRedisOptions
    const client = new Client(process.env['REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379', {
        ...contract,
        keyPrefix: PREFIX,
        lazyConnect: true,
    })
    const redisHealth = createRedisHealth(client, {
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    })
    return { default: client, redisHealth, withRedis: createWithRedis(client, redisHealth) }
})
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))

describe.skipIf(!hasPg || !hasRedis)('admin WebSocket access revocation', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users } = await import('#database/schema.js')
    const { default: databaseConfig } = await import('#config/database.js')
    const { userRepository } = await import('#app/repositories/index.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { wsRoleSync } = await import('#app/websocket/ws-role-sync.js')
    const { broadcastService } = await import('#app/services/communication/broadcast-service.js')
    const { generateWsToken } = await import('#app/services/auth/generate-ws-token-service.js')
    const { sessionHandler } = await import('#vendor/utils/session/session-handler.js')
    const { createResponseData } = await import('#vendor/utils/network/response-data.js')
    const { default: createContext } = await import('#vendor/utils/context/http-context.js')

    // Registers the WebSocket hooks, the message validator and the sessionToken check.
    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const now = Date.now()
    const createdUserIds: UserId[] = []
    const clients: WebSocket[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined
    let counter = 0

    const insertUser = async (role: Role) => {
        counter += 1
        const [row] = await db
            .insert(users)
            .values({
                name: `ws-admin-${String(counter)}`,
                email: `ws-admin-${String(counter)}-${String(now)}@example.test` as NormalizedEmail,
                // feat-240: a staff role needs a verified email (users_staff_role_verified_email).
                emailVerifiedAt: new Date(),
                role,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    const setRole = async (id: UserId, role: Role): Promise<void> => {
        await db.update(users).set({ role }).where(eq(users.id, id))
    }

    // A signed-in session and its WebSocket token (what the login response carries).
    const wsTokenFor = async (user: { id: UserId; sessionToken: string }): Promise<string> => {
        const responseData = createResponseData()
        const context = createContext(
            { method: 'get', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        await sessionHandler(context, undefined, undefined)
        // feat-247 (Р11): MFA_REQUIRED_FOR_STAFF is on by default; the session proved a second
        // factor a moment ago, so its staff access follows the role alone, which is the subject
        // here. The MFA side of the channel is in admin-channel-deadline.spec.ts.
        const at = new Date().toISOString()
        await context.auth.login(
            String(user.id),
            user.sessionToken,
            { method: 'password' },
            {
                v: 1,
                amr: ['pwd', 'otp'],
                aal: 2,
                authenticatedAt: at,
                verified: { pwd: at, otp: at },
            },
        )
        const sessionInfo = context.session.sessionInfo
        if (sessionInfo === null) throw new Error('no session after login')
        const token = await generateWsToken(sessionInfo, String(user.id))
        if (token === '') throw new Error('no ws token')
        return token
    }

    class Client extends WsTestClient {
        static connect(token: string): Promise<Client> {
            return WsTestClient.open((ws) => new Client(ws), PORT, token, clients)
        }

        subscribe(): Promise<Frame> {
            return this.request('api/admin/subscribe_online_users')
        }
    }

    const BROADCAST = 'broadcast:admin_user_online_remove'
    const ACCESS_CHANGED = 'broadcast:access_changed'
    const CHANNEL_READY = 'broadcast:admin_channel_ready'
    const publish = (): boolean =>
        broadcastService.broadcastMessageToChannel('admin', 'admin_user_online_remove', {
            id: '1',
        })

    /** Publishes until the frame count settles, so a missed delivery cannot hide in a delay. */
    const deliveredTo = async (client: Client): Promise<boolean> => {
        const before = client.received(BROADCAST)
        publish()
        await sleep(150)
        return client.received(BROADCAST) > before
    }

    const untilNotDelivered = async (client: Client, timeoutMs = 3000): Promise<number> => {
        const started = Date.now()
        while (Date.now() - started < timeoutMs) {
            if (!(await deliveredTo(client))) return Date.now() - started
        }
        return -1
    }

    beforeAll(async () => {
        await admin.connect()
        await redisClient.connect()

        const { routesHandler, createWsRoutesByUrl } = await import('#vendor/start/router.js')
        const { default: httpRoutes } = await import('#app/routes/http-routes.js')
        const { default: wsRoutes } = await import('#app/routes/ws-routes.js')
        const server = await import('#vendor/start/server.js')
        stopServer = server.stopServer
        await server.initServer({
            httpRoutes: routesHandler(httpRoutes),
            wsRoutesByUrl: createWsRoutesByUrl(routesHandler(wsRoutes)),
            sourceHttpRoutes: httpRoutes,
            sourceWsRoutes: wsRoutes,
        })
    })

    afterEach(() => {
        wsRoleSync.stop()
        wsRoleSync.reset()
    })

    afterAll(async () => {
        wsRoleSync.stop()
        for (const ws of clients) ws.close()
        await sleep(100)
        await stopServer?.('test')
        for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id))
        await cleanupTestRedis(admin)
        redisHealth.stop()
        redisClient.disconnect(false)
        await admin.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    it('delivers the admin broadcast to a subscribed admin (the baseline)', async () => {
        const user = await insertUser('admin')
        const client = await Client.connect(await wsTokenFor(user))

        expect(String((await client.subscribe()).status)).toBe('200')

        expect(await deliveredTo(client)).toBe(true)
    })

    it('stops the broadcast to an admin demoted in the database, on an open connection', async () => {
        const demoted = await insertUser('admin')
        const staying = await insertUser('admin')
        const demotedClient = await Client.connect(await wsTokenFor(demoted))
        const stayingClient = await Client.connect(await wsTokenFor(staying))
        await demotedClient.subscribe()
        await stayingClient.subscribe()
        expect(await deliveredTo(demotedClient)).toBe(true)

        await setRole(demoted.id, 'user') // out of band, as an operator would
        wsRoleSync.start(200)

        // Not an instant cut: the delay is bounded by the interval.
        const delayMs = await untilNotDelivered(demotedClient)
        expect(delayMs).toBeGreaterThanOrEqual(0)
        expect(delayMs).toBeLessThan(1500)
        // The other admin is untouched, and the demoted connection is still open.
        expect(await deliveredTo(stayingClient)).toBe(true)
        expect(demotedClient.closed).toBe(false)
    })

    it('refuses the admin routes on the demoted connection (403) but not on the admin one', async () => {
        const demoted = await insertUser('admin')
        const staying = await insertUser('admin')
        const demotedClient = await Client.connect(await wsTokenFor(demoted))
        const stayingClient = await Client.connect(await wsTokenFor(staying))
        expect(String((await demotedClient.subscribe()).status)).toBe('200')

        await setRole(demoted.id, 'user')
        wsRoleSync.start(200)
        await untilNotDelivered(demotedClient)

        const refused = await demotedClient.subscribe()
        expect(String(refused.status)).toBe('403')
        expect(String((await stayingClient.subscribe()).status)).toBe('200')
    })

    it('does not give the admin channel back to a re-subscribe without a new connection', async () => {
        const demoted = await insertUser('admin')
        const client = await Client.connect(await wsTokenFor(demoted))
        await client.subscribe()
        await setRole(demoted.id, 'user')
        wsRoleSync.start(200)
        await untilNotDelivered(client)

        await client.subscribe() // refused: the connection no longer holds the admin role

        expect(await deliveredTo(client)).toBe(false)
    })

    it('a reconnect after the demotion is a plain user connection that cannot subscribe', async () => {
        const demoted = await insertUser('admin')
        await setRole(demoted.id, 'user')

        const client = await Client.connect(await wsTokenFor(demoted))

        expect(String((await client.subscribe()).status)).toBe('403')
        expect(await deliveredTo(client)).toBe(false)
    })

    // feat-240 (Р8): a raise reaches the open connection; it is told after the role was applied,
    // so the subscription it sends next passes.
    it('raises the role on the same open connection and tells it before it subscribes', async () => {
        const promoted = await insertUser('user')
        const client = await Client.connect(await wsTokenFor(promoted))
        expect(String((await client.subscribe()).status)).toBe('403')

        await setRole(promoted.id, 'support_operator')
        wsRoleSync.start(200)
        const told = await client.waitFor((frame) => frame.event === ACCESS_CHANGED)
        expect(told.payload).toEqual({ role: 'support_operator' })

        expect(String((await client.subscribe()).status)).toBe('200')
        expect(await deliveredTo(client)).toBe(true)
        expect(client.closed).toBe(false)
    })

    it('tells a lowered connection its new role, with no channel to rejoin', async () => {
        const demoted = await insertUser('admin')
        const client = await Client.connect(await wsTokenFor(demoted))
        await client.subscribe()

        await setRole(demoted.id, 'kb_editor')
        wsRoleSync.start(200)
        const told = await client.waitFor((frame) => frame.event === ACCESS_CHANGED)

        expect(told.payload).toEqual({ role: 'kb_editor' })
        expect(await deliveredTo(client)).toBe(false)
        expect(client.received(CHANNEL_READY)).toBe(0)
    })

    it('a reconnect with the same role subscribes again and gets the events', async () => {
        const user = await insertUser('admin')
        const first = await Client.connect(await wsTokenFor(user))
        await first.subscribe()
        first.ws.close()
        await sleep(100)

        const second = await Client.connect(await wsTokenFor(user))
        expect(String((await second.subscribe()).status)).toBe('200')
        expect(await deliveredTo(second)).toBe(true)
    })

    it('revokes every connection of a demoted user', async () => {
        const demoted = await insertUser('admin')
        const first = await Client.connect(await wsTokenFor(demoted))
        const second = await Client.connect(await wsTokenFor(demoted))
        await first.subscribe()
        await second.subscribe()

        await setRole(demoted.id, 'user')
        wsRoleSync.start(200)

        expect(await untilNotDelivered(first)).toBeGreaterThanOrEqual(0)
        expect(await untilNotDelivered(second)).toBeGreaterThanOrEqual(0)
    })

    it('treats a deleted user as no longer an admin', async () => {
        const gone = await insertUser('admin')
        const client = await Client.connect(await wsTokenFor(gone))
        await client.subscribe()
        expect(await deliveredTo(client)).toBe(true)

        await db.delete(users).where(eq(users.id, gone.id))
        wsRoleSync.start(200)

        expect(await untilNotDelivered(client)).toBeGreaterThanOrEqual(0)
    })

    // A table lock makes the role query hang the way a stuck database does. One pass that
    // waits forever would block every later pass (a pass runs one at a time), and with it
    // the revocation, for as long as the query hangs.
    it('cancels a pass whose query hangs, pauses the channel, and applies the role once the database answers', async () => {
        const demoted = await insertUser('admin')
        const client = await Client.connect(await wsTokenFor(demoted))
        await client.subscribe()
        await setRole(demoted.id, 'user')
        const passes = vi.spyOn(userRepository, 'findRolesByIds')
        const holder = new pg.Client({
            host: databaseConfig.host,
            port: databaseConfig.port,
            user: databaseConfig.user,
            password: databaseConfig.password,
            database: databaseConfig.database,
        })
        await holder.connect()
        await holder.query('begin')
        await holder.query('lock table users in access exclusive mode')
        try {
            wsRoleSync.start(200)
            // Each hung query is cancelled after the 400 ms deadline, so passes keep coming.
            await sleep(1700)
            expect(passes.mock.calls.length).toBeGreaterThanOrEqual(2)
            // The role could not be read: the admin channel is paused, not kept.
            expect(await deliveredTo(client)).toBe(false)
        } finally {
            await holder.query('rollback')
            await holder.end()
        }

        await client.waitFor((frame) => frame.event === ACCESS_CHANGED)
        expect(client.received(CHANNEL_READY)).toBe(0)
        expect(String((await client.subscribe()).status)).toBe('403')
    })

    // feat-240 (Р8): a failed read pauses the channel; the server never joins it again itself.
    it('pauses the admin channel while the database cannot answer; the client rejoins after admin_channel_ready', async () => {
        const staying = await insertUser('admin')
        const client = await Client.connect(await wsTokenFor(staying))
        expect(String((await client.subscribe()).status)).toBe('200')
        const failing = vi
            .spyOn(userRepository, 'findRolesByIds')
            .mockRejectedValue(new Error('connection terminated'))

        wsRoleSync.start(200)
        await sleep(700)
        expect(failing).toHaveBeenCalled()
        expect(await deliveredTo(client)).toBe(false)
        expect(String((await client.subscribe()).status)).toBe('403')

        failing.mockRestore()
        await client.waitFor((frame) => frame.event === CHANNEL_READY)
        // Ready, but not joined: that is the client's call.
        expect(await deliveredTo(client)).toBe(false)
        expect(String((await client.subscribe()).status)).toBe('200')
        expect(await deliveredTo(client)).toBe(true)
    })

    it('a pause, then leaving the admin area, then a working database: no events come back', async () => {
        const staying = await insertUser('admin')
        const client = await Client.connect(await wsTokenFor(staying))
        await client.subscribe()
        const failing = vi
            .spyOn(userRepository, 'findRolesByIds')
            .mockRejectedValue(new Error('connection terminated'))
        wsRoleSync.start(200)
        await sleep(500)

        // Leaving needs no permission, also while the channel is paused.
        expect(String((await client.request('api/admin/unsubscribe_online_users')).status)).toBe(
            '200',
        )

        failing.mockRestore()
        await client.waitFor((frame) => frame.event === CHANNEL_READY)
        await sleep(400)
        expect(await deliveredTo(client)).toBe(false)
    })
})
