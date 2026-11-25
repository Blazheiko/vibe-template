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
import type { UserId } from '#app/domain/ids.js'

// feat-232 T7: GET/PATCH /account/profile and GET /main/init over HTTP: a real uWebSockets.js
// server with the real route table and the real session_web, csrf_guard and auth_guard, against
// a real PostgreSQL and Redis. Only per-IP limits, the throttle (account-throttle.redis.test.ts
// covers it) and notifications are replaced.

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

describe.skipIf(!hasPg || !hasRedis)('account profile over HTTP', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, userPreferences } = await import('#database/schema.js')
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
    const PASSWORD = 'profile-secret-123'
    const createdUserIds: UserId[] = []
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
            method: 'GET' | 'POST' | 'PATCH',
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

        patch(body: unknown, options: { csrf?: string | null } = {}): Promise<Reply> {
            return this.request('PATCH', '/account/profile', { body, ...options })
        }

        profile(): Promise<Reply> {
            return this.request('GET', '/account/profile')
        }
    }

    const signedIn = async (email: string): Promise<Browser> => {
        const browser = new Browser()
        await browser.signIn(email)
        return browser
    }

    const nameOf = async (id: UserId) =>
        (await db.select({ name: users.name }).from(users).where(eq(users.id, id))).at(0)?.name
    const preferencesOf = async (id: UserId) =>
        (await db.select().from(userPreferences).where(eq(userPreferences.userId, id))).at(0)

    const NULL_PREFERENCES = {
        locale: null,
        timeZone: null,
        theme: null,
        colorTheme: null,
        fontSize: null,
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

    it('an anonymous request is 401 for both routes', async () => {
        const visitor = new Browser()
        await visitor.init()

        expect((await visitor.profile()).status).toBe(401)
        expect((await visitor.patch({ theme: 'dark' })).status).toBe(401)
    })

    it('PATCH without the CSRF token is 403 and writes nothing', async () => {
        const user = await insertUser('profile-csrf')
        const browser = await signedIn(user.email ?? '')

        const reply = await browser.patch({ name: 'No CSRF' }, { csrf: null })

        expect(reply.status).toBe(403)
        expect(reply.body).toMatchObject({ code: 'csrf_invalid' })
        expect(await nameOf(user.id)).toBe('profile-csrf')
    })

    it('the initial profile, the first PATCH of the name and a later zone, as GET and init see them', async () => {
        const user = await insertUser('profile-path')
        const browser = await signedIn(user.email ?? '')

        const empty = await browser.profile()
        expect(empty.status).toBe(200)
        expect(empty.body).toEqual({
            status: 'success',
            profile: { name: 'profile-path', preferences: NULL_PREFERENCES, revision: '0' },
        })
        const emptyInit = await browser.init()
        expect(emptyInit.body['user']).toMatchObject({
            preferences: NULL_PREFERENCES,
            revision: '0',
        })

        const named = await browser.patch({ name: '  Renamed  ' })
        expect(named.status).toBe(200)
        expect(named.body).toMatchObject({ profile: { name: 'Renamed', revision: '1' } })
        expect((await browser.profile()).body).toMatchObject({
            profile: { name: 'Renamed', revision: '1' },
        })
        expect((await browser.init()).body['user']).toMatchObject({
            name: 'Renamed',
            revision: '1',
        })

        const zoned = await browser.patch({ timeZone: 'UTC' })
        expect(zoned.body).toMatchObject({
            profile: { preferences: { timeZone: 'UTC' }, revision: '2' },
        })
        expect((await browser.profile()).body).toMatchObject({
            profile: { preferences: { timeZone: 'UTC' }, revision: '2' },
        })
        expect((await browser.init()).body['user']).toMatchObject({
            preferences: { timeZone: 'UTC' },
            revision: '2',
        })
    })

    it('a partial PATCH keeps the other preferences; null resets one', async () => {
        const user = await insertUser('profile-partial')
        const browser = await signedIn(user.email ?? '')

        await browser.patch({ locale: 'uk', theme: 'dark', colorTheme: 'mint', fontSize: 18 })
        const reset = await browser.patch({ theme: null })

        expect(reset.body).toMatchObject({
            profile: {
                preferences: {
                    locale: 'uk',
                    timeZone: null,
                    theme: null,
                    colorTheme: 'mint',
                    fontSize: 18,
                },
                revision: '2',
            },
        })
    })

    it('a refused body is 422 or 400 and writes nothing', async () => {
        const user = await insertUser('profile-invalid')
        const browser = await signedIn(user.email ?? '')

        for (const body of [{}, { name: '' }, { name: null }, { fontSize: 21 }, { other: 1 }]) {
            const reply = await browser.patch(body)
            expect(reply.status, JSON.stringify(body)).toBe(422)
            expect(reply.body).toMatchObject({ code: 'validation_failed' })
        }
        const zone = await browser.patch({ timeZone: 'Mars/Base' })
        expect(zone.status).toBe(400)
        expect(zone.body).toMatchObject({ reason: 'unknown_time_zone' })

        expect(await nameOf(user.id)).toBe('profile-invalid')
        expect(await preferencesOf(user.id)).toBeUndefined()
    })

    it('a session revoked by a logout everywhere: the same answer as a password change, no write', async () => {
        const user = await insertUser('profile-logout-all')
        const a = await signedIn(user.email ?? '')
        const b = await signedIn(user.email ?? '')
        expect((await b.request('POST', '/auth/logout-all', { body: {} })).status).toBe(200)

        const profile = await a.patch({ name: 'After logout all', theme: 'dark' })
        const password = await a.request('POST', '/auth/change-password', {
            body: { newPassword: 'another-secret-456' },
        })

        // The session record is gone, so csrf_guard refuses first (403), as for a password change.
        expect(profile.status).toBe(403)
        expect(profile.status).toBe(password.status)
        expect(profile.body['code']).toBe(password.body['code'])
        expect(await nameOf(user.id)).toBe('profile-logout-all')
        expect(await preferencesOf(user.id)).toBeUndefined()
    })

    it('a session ended by a logout in another tab: the same answer as a password change, no write', async () => {
        const user = await insertUser('profile-logout-tab')
        const tab = await signedIn(user.email ?? '')
        const otherTab = new Browser()
        otherTab.cookie = tab.cookie
        otherTab.csrf = tab.csrf
        expect((await otherTab.request('POST', '/auth/logout', { body: {} })).status).toBe(200)

        const profile = await tab.patch({ fontSize: 20 })
        const password = await tab.request('POST', '/auth/change-password', {
            body: { newPassword: 'another-secret-456' },
        })

        // The session record is gone, so csrf_guard refuses first (403), as for a password change.
        expect(profile.status).toBe(403)
        expect(profile.status).toBe(password.status)
        expect(profile.body['code']).toBe(password.body['code'])
        expect(await preferencesOf(user.id)).toBeUndefined()
    })
})
