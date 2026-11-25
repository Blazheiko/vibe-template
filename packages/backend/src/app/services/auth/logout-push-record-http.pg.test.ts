import { createServer } from 'node:net'

import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'
import type { UserId } from '#app/domain/ids.js'

// feat-254 over HTTP: POST /auth/logout with `pushEndpoint` deletes this browser's push record of
// the signed-in user together with the session, and only when the session really ended. A real
// uWebSockets.js server with the real route table, session_web, csrf_guard and auth_guard, against
// a real PostgreSQL and Redis. A logout the server keeps (503 `logout_retry`, Р13) is made real:
// another transaction holds the user's row past every lock wait (DB_QUERY_TIMEOUT_MS is 400 here).

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
const ORIGIN = `http://localhost:${String(PORT)}`

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['CSRF_ENFORCE'] = 'true'
    process.env['CSRF_STRICT_ORIGIN'] = 'true'
    // Every statement of the pool, the lock waits of the logout too, is cut after this.
    process.env['DB_QUERY_TIMEOUT_MS'] = '400'
    return { PREFIX: `test:${crypto.randomUUID()}:` }
})
process.env['CSRF_ALLOWED_ORIGINS'] = ORIGIN

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
vi.mock('#vendor/utils/rate-limit/http-rate-limit.js', () => ({
    default: () => true,
    checkGlobalRateLimit: () => true,
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))

describe.skipIf(!hasPg || !hasRedis)('POST /auth/logout and the push record', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, pushSubscriptions } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { hashPassword } = await import('metautil')
    const { pushSubscriptionRepository } = await import('#app/repositories/index.js')
    const { default: sessionConfig } = await import('#config/session.js')
    const { default: databaseConfig } = await import('#config/database.js')

    // Registers the WebSocket hooks (needed by stopServer), the sessionToken check and the
    // session deletion lock (the user's row lock).
    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const PASSWORD = 'push-logout-123'
    const createdUserIds: UserId[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined

    const insertUser = async (name: string) => {
        const [row] = await db
            .insert(users)
            .values({
                name,
                email: `${name}-${crypto.randomUUID()}@example.test`,
                password: await hashPassword(PASSWORD),
                emailVerifiedAt: new Date(),
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    /** A push record of the user, stored in its canonical form. */
    const insertRecord = async (userId: UserId) => {
        const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`
        const [row] = await db
            .insert(pushSubscriptions)
            .values({ userId, endpoint, p256dhKey: 'p', authKey: 'a' })
            .returning()
        if (row === undefined) throw new Error('push record not inserted')
        return row
    }

    const recordExists = async (id: bigint): Promise<boolean> =>
        (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id))).length > 0

    interface Reply {
        status: number
        body: Record<string, unknown>
        setCookie: string | undefined
    }

    // One browser: a cookie and the CSRF token of its current session.
    class Browser {
        cookie: string | undefined
        csrf: string | undefined

        async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
            const headers: Record<string, string> = { origin: ORIGIN }
            if (this.cookie !== undefined)
                headers['cookie'] = `${sessionConfig.cookieName}=${this.cookie}`
            if (this.csrf !== undefined) headers['x-csrf-token'] = this.csrf
            if (body !== undefined) headers['content-type'] = 'application/json'
            const response = await fetch(`http://127.0.0.1:${String(PORT)}/api${path}`, {
                method,
                headers,
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            })
            const text = await response.text()
            const parsed = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>
            const setCookie = response.headers
                .getSetCookie()
                .find((value) => value.startsWith(`${sessionConfig.cookieName}=`))
            return { status: response.status, body: parsed, setCookie }
        }

        keep(reply: Reply): Reply {
            if (reply.setCookie !== undefined) {
                this.cookie = reply.setCookie.slice(
                    sessionConfig.cookieName.length + 1,
                    reply.setCookie.indexOf(';'),
                )
            }
            if (typeof reply.body['csrfToken'] === 'string') this.csrf = reply.body['csrfToken']
            return reply
        }

        async signIn(email: string): Promise<void> {
            this.keep(await this.request('GET', '/main/init'))
            const reply = this.keep(
                await this.request('POST', '/auth/login', {
                    identifier: email,
                    password: PASSWORD,
                }),
            )
            expect(reply.status).toBe(200)
        }

        isSignedIn = async (): Promise<boolean> =>
            (await this.request('GET', '/main/init')).status === 200
    }

    const signedIn = async (email: string | null): Promise<Browser> => {
        const browser = new Browser()
        await browser.signIn(email ?? '')
        return browser
    }

    beforeAll(async () => {
        await admin.connect()
        await redisClient.connect()

        const { routesHandler } = await import('#vendor/start/router.js')
        const { default: httpRoutes } = await import('#app/routes/http-routes.js')
        const server = await import('#vendor/start/server.js')
        stopServer = server.stopServer
        await server.initServer({
            httpRoutes: routesHandler(httpRoutes),
            wsRoutesByUrl: new Map(),
            sourceHttpRoutes: httpRoutes,
            sourceWsRoutes: [],
        } as never)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        await stopServer?.('test')
        // push_subscriptions cascade with the user.
        for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id))
        await cleanupTestRedis(admin)
        redisHealth.stop()
        redisClient.disconnect(false)
        await admin.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    it('deletes the record of this browser with the session, and no other record', async () => {
        const user = await insertUser('push-logout')
        const thisBrowser = await insertRecord(user.id)
        const otherDevice = await insertRecord(user.id)
        const a = await signedIn(user.email)

        // Another spelling of the same endpoint (an upper-case host) is the same endpoint.
        const reply = a.keep(
            await a.request('POST', '/auth/logout', {
                pushEndpoint: thisBrowser.endpoint.replace(
                    'fcm.googleapis.com',
                    'FCM.googleapis.com',
                ),
            }),
        )

        expect(reply.status).toBe(200)
        expect(reply.body).toMatchObject({ status: 'success' })
        expect(await recordExists(thisBrowser.id)).toBe(false)
        expect(await recordExists(otherDevice.id)).toBe(true)
        expect(await a.isSignedIn()).toBe(false)
    })

    it("never deletes another user's record with that endpoint", async () => {
        const user = await insertUser('push-logout-me')
        const other = await insertUser('push-logout-other')
        const othersRecord = await insertRecord(other.id)
        const a = await signedIn(user.email)

        const reply = a.keep(
            await a.request('POST', '/auth/logout', { pushEndpoint: othersRecord.endpoint }),
        )

        expect(reply.status).toBe(200)
        expect(await recordExists(othersRecord.id)).toBe(true)
        const [row] = await db
            .select()
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.id, othersRecord.id))
        expect(row?.userId).toBe(other.id)
    })

    it('a logout the server keeps (503 logout_retry) keeps the record; the repeat deletes it', async () => {
        const user = await insertUser('push-logout-kept')
        const record = await insertRecord(user.id)
        const a = await signedIn(user.email)
        const holder = new pg.Client({
            host: databaseConfig.host,
            port: databaseConfig.port,
            user: databaseConfig.user,
            password: databaseConfig.password,
            database: databaseConfig.database,
        })
        await holder.connect()
        await holder.query('begin')
        await holder.query('select id from users where id = $1 for update', [String(user.id)])
        try {
            const kept = a.keep(
                await a.request('POST', '/auth/logout', { pushEndpoint: record.endpoint }),
            )
            expect(kept.status).toBe(503)
            expect(kept.body).toMatchObject({ reason: 'logout_retry' })
        } finally {
            await holder.query('rollback')
            await holder.end()
        }
        expect(await recordExists(record.id)).toBe(true)
        expect(await a.isSignedIn()).toBe(true)

        const repeated = a.keep(
            await a.request('POST', '/auth/logout', { pushEndpoint: record.endpoint }),
        )
        expect(repeated.status).toBe(200)
        expect(await recordExists(record.id)).toBe(false)
    })

    it('a failed push delete still answers a successful logout', async () => {
        const user = await insertUser('push-logout-fail')
        const record = await insertRecord(user.id)
        const a = await signedIn(user.email)
        vi.spyOn(pushSubscriptionRepository, 'findByEndpoint').mockRejectedValue(
            new Error('connection terminated'),
        )

        const reply = a.keep(
            await a.request('POST', '/auth/logout', { pushEndpoint: record.endpoint }),
        )

        expect(reply.status).toBe(200)
        expect(reply.body).toMatchObject({ status: 'success' })
        expect(await a.isSignedIn()).toBe(false)
        expect(await recordExists(record.id)).toBe(true)
    })

    it('without pushEndpoint the logout leaves every push record alone', async () => {
        const user = await insertUser('push-logout-none')
        const record = await insertRecord(user.id)
        const a = await signedIn(user.email)

        const reply = a.keep(await a.request('POST', '/auth/logout', {}))

        expect(reply.status).toBe(200)
        expect(await a.isSignedIn()).toBe(false)
        expect(await recordExists(record.id)).toBe(true)
    })

    it('refuses a pushEndpoint longer than the column', async () => {
        const user = await insertUser('push-logout-long')
        const a = await signedIn(user.email)

        const reply = await a.request('POST', '/auth/logout', { pushEndpoint: 'x'.repeat(501) })

        expect(reply.status).toBe(422)
        expect(await a.isSignedIn()).toBe(true)
    })
})
