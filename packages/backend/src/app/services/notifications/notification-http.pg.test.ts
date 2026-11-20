import { createServer } from 'node:net'

import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'

// feat-236 T5 (Р4, Р6): the notification center over HTTP — a real uWebSockets.js server with the
// real route table and the real session_web, csrf_guard and auth_guard, against a real PostgreSQL
// and Redis. The sign-in notices are replaced, so a test owns every notification it reads.

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
    process.env['SESSION_TOKEN_CHECK_TIMEOUT_MS'] = '400'
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

describe.skipIf(!hasPg || !hasRedis)('notification center over HTTP', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, notifications } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { hashPassword } = await import('metautil')
    const { default: sessionConfig } = await import('#config/session.js')

    // Registers the WebSocket hooks (needed by stopServer) and the sessionToken check.
    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const now = Date.now()
    const PASSWORD = 'notification-secret-123'
    const createdUserIds: bigint[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined

    const insertUser = async (name: string) => {
        const [row] = await db
            .insert(users)
            .values({
                name,
                email: `${name}-${String(now)}@example.test`,
                password: await hashPassword(PASSWORD),
                emailVerifiedAt: new Date(),
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    interface Reply {
        status: number
        body: Record<string, unknown>
        setCookie: string | undefined
    }

    // One browser: a cookie and the CSRF token of its current session.
    class Browser {
        cookie: string | undefined
        csrf: string | undefined

        async request(
            method: 'GET' | 'POST' | 'PUT',
            path: string,
            options: { body?: unknown; csrf?: string | null } = {},
        ): Promise<Reply> {
            const headers: Record<string, string> = { origin: ORIGIN }
            if (this.cookie !== undefined)
                headers['cookie'] = `${sessionConfig.cookieName}=${this.cookie}`
            const csrf = options.csrf === undefined ? this.csrf : options.csrf
            if (csrf !== null && csrf !== undefined) headers['x-csrf-token'] = csrf
            if (options.body !== undefined) headers['content-type'] = 'application/json'
            const response = await fetch(`http://127.0.0.1:${String(PORT)}/api${path}`, {
                method,
                headers,
                ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
            })
            const text = await response.text()
            const body = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>
            const setCookie = response.headers
                .getSetCookie()
                .find((value) => value.startsWith(`${sessionConfig.cookieName}=`))
            return { status: response.status, body, setCookie }
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

        init(): Promise<Reply> {
            return this.request('GET', '/main/init').then((reply) => this.keep(reply))
        }

        async signIn(email: string): Promise<void> {
            await this.init()
            const reply = this.keep(
                await this.request('POST', '/auth/login', {
                    body: { identifier: email, password: PASSWORD },
                }),
            )
            expect(reply.status).toBe(200)
        }
    }

    const signedIn = async (email: string): Promise<Browser> => {
        const browser = new Browser()
        await browser.signIn(email)
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

    afterAll(async () => {
        await stopServer?.('test')
        for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id))
        await cleanupTestRedis(admin)
        redisHealth.stop()
        redisClient.disconnect(false)
        await admin.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    const add = async (userId: bigint, link: string | null = '/account'): Promise<bigint> => {
        const [row] = await db
            .insert(notifications)
            .values({ userId, category: 'security', kind: 'security.logout_all', params: {}, link })
            .returning({ id: notifications.id })
        if (row === undefined) throw new Error('notification not inserted')
        return row.id
    }
    const readAtOf = async (id: bigint) =>
        (
            await db
                .select({ readAt: notifications.readAt })
                .from(notifications)
                .where(eq(notifications.id, id))
        ).at(0)?.readAt

    const OUT_OF_RANGE = '9223372036854775808'

    it('anonymous: 401 for every route', async () => {
        const visitor = new Browser()
        await visitor.init()
        for (const [method, path, body] of [
            ['GET', '/notifications', undefined],
            ['GET', '/notifications/unread-count', undefined],
            ['POST', '/notifications/1/read', {}],
            ['POST', '/notifications/read-all', { upTo: '1' }],
            ['GET', '/notifications/preferences', undefined],
            [
                'PUT',
                '/notifications/preferences',
                { category: 'support', channel: 'push', enabled: false },
            ],
        ] as const) {
            expect((await visitor.request(method, path, { body })).status, path).toBe(401)
        }
    })

    it('pages newest first with a cursor; 20 by default; the unread filter', async () => {
        const user = await insertUser(`notif-page-${String(now)}`)
        const browser = await signedIn(user.email ?? '')
        const ids: bigint[] = []
        for (let i = 0; i < 25; i++) ids.push(await add(user.id))

        const first = await browser.request('GET', '/notifications')
        expect(first.status).toBe(200)
        const items = first.body['items'] as { id: string; kind: string; readAt: null }[]
        expect(items).toHaveLength(20)
        expect(items[0]).toMatchObject({
            id: String(ids[24]),
            kind: 'security.logout_all',
            category: 'security',
            params: {},
            link: '/account',
            readAt: null,
        })
        expect(first.body['unreadCount']).toBe(25)
        expect(first.body['next']).toBe(String(ids[5]))

        const second = await browser.request(
            'GET',
            `/notifications?before=${String(first.body['next'])}&limit=10`,
        )
        expect((second.body['items'] as unknown[]).length).toBe(5)
        expect(second.body['next']).toBeNull()

        await browser.request('POST', `/notifications/${String(ids[24])}/read`, { body: {} })
        const unread = await browser.request('GET', '/notifications?unread=1&limit=50')
        expect((unread.body['items'] as unknown[]).length).toBe(24)
    })

    it('read: another user, a missing id, a malformed id and one past bigint are one 404', async () => {
        const owner = await insertUser(`notif-owner-${String(now)}`)
        const other = await insertUser(`notif-other-${String(now)}`)
        const id = await add(owner.id)
        const browser = await signedIn(other.email ?? '')

        for (const target of [String(id), '9000000000000', 'abc', '0', OUT_OF_RANGE]) {
            const reply = await browser.request('POST', `/notifications/${target}/read`, {
                body: {},
            })
            expect(reply.status, target).toBe(404)
            expect(reply.body['code'], target).toBe('not_found')
        }
        // The answer and the row: the owner's notification is still unread.
        expect(await readAtOf(id)).toBeNull()
    })

    it('read is idempotent: the same link again, read_at unchanged; a null link', async () => {
        const user = await insertUser(`notif-read-${String(now)}`)
        const browser = await signedIn(user.email ?? '')
        const id = await add(user.id, '/account#sessions')
        const plain = await add(user.id, null)

        const first = await browser.request('POST', `/notifications/${String(id)}/read`, {
            body: {},
        })
        expect(first.status).toBe(200)
        expect(first.body).toEqual({
            status: 'success',
            link: '/account#sessions',
            unreadCount: 1,
        })
        const readAt = await readAtOf(id)
        const again = await browser.request('POST', `/notifications/${String(id)}/read`, {
            body: {},
        })
        expect(again.body).toEqual(first.body)
        expect(await readAtOf(id)).toEqual(readAt)

        const none = await browser.request('POST', `/notifications/${String(plain)}/read`, {
            body: {},
        })
        expect(none.body).toEqual({ status: 'success', link: null, unreadCount: 0 })
    })

    it('read-all marks every id <= upTo and none above', async () => {
        const user = await insertUser(`notif-all-${String(now)}`)
        const browser = await signedIn(user.email ?? '')
        const ids: bigint[] = []
        for (let i = 0; i < 4; i++) ids.push(await add(user.id))

        const reply = await browser.request('POST', '/notifications/read-all', {
            body: { upTo: String(ids[2]) },
        })
        expect(reply.body).toEqual({ status: 'success', unreadCount: 1 })
        expect(await readAtOf(ids[3]!)).toBeNull()
        expect(await readAtOf(ids[0]!)).toBeInstanceOf(Date)
    })

    it('bounds: a cursor or upTo past bigint, a limit outside 1-50 are refused before SQL', async () => {
        const user = await insertUser(`notif-bounds-${String(now)}`)
        const browser = await signedIn(user.email ?? '')

        const cursor = await browser.request('GET', `/notifications?before=${OUT_OF_RANGE}`)
        expect(cursor.status).toBe(400)
        const upTo = await browser.request('POST', '/notifications/read-all', {
            body: { upTo: OUT_OF_RANGE },
        })
        expect(upTo.status).toBe(400)
        for (const limit of ['0', '51', 'x']) {
            expect((await browser.request('GET', `/notifications?limit=${limit}`)).status).toBe(422)
        }
    })

    it('preferences: defaults, a change, locked and absent channels refused', async () => {
        const user = await insertUser(`notif-prefs-${String(now)}`)
        const browser = await signedIn(user.email ?? '')

        const initial = await browser.request('GET', '/notifications/preferences')
        expect(initial.body['preferences']).toEqual([
            { category: 'security', channel: 'push', enabled: true, locked: false },
            { category: 'security', channel: 'email', enabled: true, locked: true },
            { category: 'support', channel: 'push', enabled: true, locked: false },
        ])

        const changed = await browser.request('PUT', '/notifications/preferences', {
            body: { category: 'support', channel: 'push', enabled: false },
        })
        expect(changed.status).toBe(200)
        expect(changed.body['preferences']).toContainEqual({
            category: 'support',
            channel: 'push',
            enabled: false,
            locked: false,
        })

        const locked = await browser.request('PUT', '/notifications/preferences', {
            body: { category: 'security', channel: 'email', enabled: false },
        })
        expect(locked.status).toBe(400)
        expect(locked.body['reason']).toBe('channel_locked')
        const absent = await browser.request('PUT', '/notifications/preferences', {
            body: { category: 'support', channel: 'email', enabled: true },
        })
        expect(absent.status).toBe(400)
        expect(absent.body['reason']).toBe('channel_unavailable')
    })

    it('a mutation without the CSRF token is refused and changes nothing', async () => {
        const user = await insertUser(`notif-csrf-${String(now)}`)
        const browser = await signedIn(user.email ?? '')
        const id = await add(user.id)

        const reply = await browser.request('POST', `/notifications/${String(id)}/read`, {
            body: {},
            csrf: null,
        })
        expect(reply.status).toBe(403)
        expect(await readAtOf(id)).toBeNull()
    })
})
