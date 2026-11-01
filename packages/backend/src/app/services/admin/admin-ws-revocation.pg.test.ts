import { createServer } from 'node:net'

import { eq } from 'drizzle-orm'
import pg from 'pg'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../../test-support/redis-test-client.js'

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
    const { adminWsAccessService } = await import('#app/services/admin/admin-ws-access-service.js')
    const { broadcastService } = await import('#app/services/communication/broadcast-service.js')
    const { generateWsToken } = await import('#app/services/auth/generate-ws-token-service.js')
    const { sessionHandler } = await import('#vendor/utils/session/session-handler.js')
    const { createResponseData } = await import('#vendor/utils/network/response-data.js')
    const { default: createContext } = await import('#vendor/utils/context/http-context.js')

    // Registers the WebSocket hooks, the message validator and the sessionToken check.
    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const now = Date.now()
    const createdUserIds: bigint[] = []
    const clients: WebSocket[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined
    let counter = 0

    const insertUser = async (role: 'user' | 'admin') => {
        counter += 1
        const [row] = await db
            .insert(users)
            .values({
                name: `ws-admin-${String(counter)}`,
                email: `ws-admin-${String(counter)}-${String(now)}@example.test`,
                role,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    const setRole = async (id: bigint, role: 'user' | 'admin'): Promise<void> => {
        await db.update(users).set({ role }).where(eq(users.id, id))
    }

    // A signed-in session and its WebSocket token (what the login response carries).
    const wsTokenFor = async (user: { id: bigint; sessionToken: string }): Promise<string> => {
        const responseData = createResponseData()
        const context = createContext(
            { method: 'get', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        await sessionHandler(context, undefined, undefined)
        await context.auth.login(String(user.id), user.sessionToken)
        const sessionInfo = context.session.sessionInfo
        if (sessionInfo === null) throw new Error('no session after login')
        const token = await generateWsToken(sessionInfo, String(user.id))
        if (token === '') throw new Error('no ws token')
        return token
    }

    interface Frame {
        event?: string
        status?: string | number
        timestamp?: number
        data?: unknown
    }

    class Client {
        readonly frames: Frame[] = []
        closed = false
        private constructor(readonly ws: WebSocket) {
            ws.addEventListener('message', (message) => {
                this.frames.push(JSON.parse(String(message.data)) as Frame)
            })
            ws.addEventListener('close', () => {
                this.closed = true
            })
        }

        static async connect(token: string): Promise<Client> {
            const ws = new WebSocket(`ws://127.0.0.1:${String(PORT)}/api/websocket`, [token])
            clients.push(ws)
            await new Promise<void>((resolve, reject) => {
                ws.addEventListener('open', () => {
                    resolve()
                })
                ws.addEventListener('error', () => {
                    reject(new Error('websocket failed to open'))
                })
            })
            const client = new Client(ws)
            await client.waitFor((frame) => frame.event === 'service:connection_established')
            return client
        }

        async waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
            const started = Date.now()
            for (;;) {
                const found = this.frames.find(predicate)
                if (found !== undefined) return found
                if (Date.now() - started > timeoutMs) {
                    throw new Error(
                        `no matching frame in ${String(timeoutMs)} ms: ${JSON.stringify(this.frames)}`,
                    )
                }
                await sleep(20)
            }
        }

        /** Sends a request and returns the reply that carries the same event and timestamp. */
        async request(event: string): Promise<Frame> {
            const timestamp = Date.now() + this.frames.length
            this.ws.send(JSON.stringify({ event, payload: null, timestamp }))
            return this.waitFor((frame) => frame.event === event && frame.timestamp === timestamp)
        }

        subscribe(): Promise<Frame> {
            return this.request('api/admin/subscribe_online_users')
        }

        received(event: string): number {
            return this.frames.filter((frame) => frame.event === event).length
        }
    }

    const BROADCAST = 'broadcast:admin_user_online_remove'
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
        adminWsAccessService.stop()
    })

    afterAll(async () => {
        adminWsAccessService.stop()
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
        adminWsAccessService.start(200)

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
        adminWsAccessService.start(200)
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
        adminWsAccessService.start(200)
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

    it('does not raise a role on an open connection: a promotion needs a reconnect', async () => {
        const promoted = await insertUser('user')
        const client = await Client.connect(await wsTokenFor(promoted))
        expect(String((await client.subscribe()).status)).toBe('403')

        await setRole(promoted.id, 'admin')
        adminWsAccessService.start(200)
        await sleep(600)
        expect(String((await client.subscribe()).status)).toBe('403')

        // After a reconnect the connection is opened with the role read from the database.
        const reconnected = await Client.connect(await wsTokenFor(promoted))
        expect(String((await reconnected.subscribe()).status)).toBe('200')
        expect(await deliveredTo(reconnected)).toBe(true)
    })

    it('revokes every connection of a demoted user', async () => {
        const demoted = await insertUser('admin')
        const first = await Client.connect(await wsTokenFor(demoted))
        const second = await Client.connect(await wsTokenFor(demoted))
        await first.subscribe()
        await second.subscribe()

        await setRole(demoted.id, 'user')
        adminWsAccessService.start(200)

        expect(await untilNotDelivered(first)).toBeGreaterThanOrEqual(0)
        expect(await untilNotDelivered(second)).toBeGreaterThanOrEqual(0)
    })

    it('treats a deleted user as no longer an admin', async () => {
        const gone = await insertUser('admin')
        const client = await Client.connect(await wsTokenFor(gone))
        await client.subscribe()
        expect(await deliveredTo(client)).toBe(true)

        await db.delete(users).where(eq(users.id, gone.id))
        adminWsAccessService.start(200)

        expect(await untilNotDelivered(client)).toBeGreaterThanOrEqual(0)
    })

    // A table lock makes the role query hang the way a stuck database does. One pass that
    // waits forever would block every later pass (a pass runs one at a time), and with it
    // the revocation, for as long as the query hangs.
    it('cancels a pass whose query hangs, runs the next pass, and revokes once the database answers', async () => {
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
            adminWsAccessService.start(200)
            // Each hung query is cancelled after the 400 ms deadline, so passes keep coming.
            await sleep(1700)
            expect(passes.mock.calls.length).toBeGreaterThanOrEqual(2)
            // Nothing could be verified meanwhile, so nothing was changed.
            expect(await deliveredTo(client)).toBe(true)
        } finally {
            await holder.query('rollback')
            await holder.end()
        }

        expect(await untilNotDelivered(client)).toBeGreaterThanOrEqual(0)
    })

    it('keeps the subscriptions while the database cannot answer, and revokes once it can', async () => {
        const demoted = await insertUser('admin')
        const client = await Client.connect(await wsTokenFor(demoted))
        await client.subscribe()
        await setRole(demoted.id, 'user')
        const failing = vi
            .spyOn(userRepository, 'findRolesByIds')
            .mockRejectedValue(new Error('connection terminated'))

        adminWsAccessService.start(200)
        await sleep(700)
        // Nothing could be verified, so nothing changed (and nothing crashed).
        expect(failing).toHaveBeenCalled()
        expect(await deliveredTo(client)).toBe(true)

        failing.mockRestore()
        expect(await untilNotDelivered(client)).toBeGreaterThanOrEqual(0)
    })
})
