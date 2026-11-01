import { createServer } from 'node:net'

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import type * as SessionStorage from '#vendor/utils/session/redis-session-storage.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'

// ADR 0002 over HTTP: a real uWebSockets.js server with the real route table and the
// real session_web, csrf_guard and auth_guard, against a real PostgreSQL and Redis.
// Only what is not under test is replaced: per-IP rate limits, throttling and
// notifications. The cleanup of the Redis records (destroyAllSessions) can be made to
// fail, the way an unreachable Redis makes it fail.

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

const cleanup = vi.hoisted(() => ({ fail: false }))
vi.mock('#vendor/utils/session/redis-session-storage.js', async (importActual) => {
    const actual = await importActual<typeof SessionStorage>()
    const { RedisUnavailableError } =
        await import('#vendor/utils/network/errors/redis-unavailable-error.js')
    return {
        ...actual,
        destroyAllSessions: (...args: Parameters<typeof actual.destroyAllSessions>) => {
            if (cleanup.fail) return Promise.reject(new RedisUnavailableError('cleanup failed'))
            return actual.destroyAllSessions(...args)
        },
    }
})

describe.skipIf(!hasPg || !hasRedis)('session revocation over HTTP', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, passwordResetTokens } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { hashPassword, validatePassword } = await import('metautil')
    const { userRepository, passwordResetRepository } = await import('#app/repositories/index.js')
    const { getSession } = await import('#vendor/utils/session/redis-session-storage.js')
    const { default: sessionConfig } = await import('#config/session.js')

    // Registers the WebSocket hooks (needed by stopServer) and the sessionToken check.
    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const now = Date.now()
    const OLD_PASSWORD = 'old-secret-123'
    const createdUserIds: bigint[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined

    const insertUser = async (name: string) => {
        const [row] = await db
            .insert(users)
            .values({
                name,
                email: `${name}-${String(now)}@example.test`,
                password: await hashPassword(OLD_PASSWORD),
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
        headers: Headers
        setCookie: string | undefined
    }

    // One browser: a cookie and the CSRF token of its current session.
    class Browser {
        cookie: string | undefined
        csrf: string | undefined

        async request(
            method: 'GET' | 'POST',
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
            return { status: response.status, body, headers: response.headers, setCookie }
        }

        /** Applies what a real browser would keep from a reply: the cookie and the token. */
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

        async signIn(email: string, password = OLD_PASSWORD): Promise<void> {
            await this.init() // anonymous session and its CSRF token (401)
            const reply = this.keep(
                await this.request('POST', '/auth/login', {
                    body: { identifier: email, password, token: '' },
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

    const rowOf = async (id: bigint) => {
        const [row] = await db.select().from(users).where(eq(users.id, id))
        return row
    }

    const sessionIdOf = (browser: Browser): string => {
        const value = Buffer.from(browser.cookie ?? '', 'base64').toString()
        const parts = value.split('.')
        const sessionId = parts[1]
        if (sessionId === undefined) throw new Error('unexpected cookie format')
        return sessionId
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
        cleanup.fail = false
        vi.restoreAllMocks()
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

    describe('POST /auth/change-password', () => {
        it('revokes the other sessions and the old cookie, and renews the caller', async () => {
            const user = await insertUser('http-change')
            const a = await signedIn(user.email ?? '')
            const b = await signedIn(user.email ?? '')
            expect((await a.request('GET', '/main/init')).status).toBe(200)
            expect((await b.request('GET', '/main/init')).status).toBe(200)
            const oldCookie = a.cookie
            const oldCsrf = a.csrf

            const reply = a.keep(
                await a.request('POST', '/auth/change-password', {
                    body: { currentPassword: OLD_PASSWORD, newPassword: 'new-secret-456' },
                }),
            )

            expect(reply.status).toBe(200)
            expect(reply.body).toMatchObject({
                status: 'success',
                sessionRenewed: true,
                csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
                wsToken: expect.any(String),
                wsUrl: expect.any(String),
            })
            expect(reply.setCookie).toBeDefined()
            expect(a.cookie).not.toBe(oldCookie)
            expect(a.csrf).not.toBe(oldCsrf)

            // The old cookie of A and B's cookie open nothing ...
            const stale = new Browser()
            stale.cookie = oldCookie
            expect((await stale.request('GET', '/main/init')).status).toBe(401)
            expect((await b.request('GET', '/main/init')).status).toBe(401)
            // ... the renewed session does, and only with its new CSRF token.
            expect((await a.request('GET', '/main/init')).status).toBe(200)
            const withOldCsrf = await a.request('POST', '/auth/logout', {
                body: {},
                csrf: oldCsrf ?? null,
            })
            expect(withOldCsrf.status).toBe(403)

            const row = await rowOf(user.id)
            expect(await validatePassword('new-secret-456', row?.password ?? '')).toBe(true)
            expect(row?.sessionToken).not.toBe(user.sessionToken)
        })

        it('keeps the sessions revoked when the Redis cleanup fails', async () => {
            const user = await insertUser('http-change-down')
            const a = await signedIn(user.email ?? '')
            const b = await signedIn(user.email ?? '')
            const bSessionId = sessionIdOf(b)
            cleanup.fail = true

            const reply = a.keep(
                await a.request('POST', '/auth/change-password', {
                    body: { currentPassword: OLD_PASSWORD, newPassword: 'new-secret-456' },
                }),
            )

            // The change succeeded and the caller is renewed ...
            expect(reply.status).toBe(200)
            expect(reply.body).toMatchObject({ status: 'success', sessionRenewed: true })
            // ... B's record is still in Redis, yet its very next request is refused.
            expect(await getSession(bSessionId, user.sessionToken)).not.toBeNull()
            cleanup.fail = false
            expect((await b.request('GET', '/main/init')).status).toBe(401)
        })

        it('lets exactly one of two concurrent changes win', async () => {
            const user = await insertUser('http-race')
            const a = await signedIn(user.email ?? '')
            const b = await signedIn(user.email ?? '')

            const [first, second] = await Promise.all([
                a.request('POST', '/auth/change-password', {
                    body: { currentPassword: OLD_PASSWORD, newPassword: 'winner-one-111' },
                }),
                b.request('POST', '/auth/change-password', {
                    body: { currentPassword: OLD_PASSWORD, newPassword: 'winner-two-222' },
                }),
            ])

            const replies = [first, second]
            expect(replies.filter((reply) => reply.status === 200)).toHaveLength(1)
            // The loser is a conflict, a wrong current password (the winner was first), or
            // a session the winner has already revoked.
            const loser = replies.find((reply) => reply.status !== 200)
            expect([400, 401, 403, 409]).toContain(loser?.status)

            const winnerPassword = first.status === 200 ? 'winner-one-111' : 'winner-two-222'
            const loserPassword = first.status === 200 ? 'winner-two-222' : 'winner-one-111'
            const row = await rowOf(user.id)
            expect(await validatePassword(winnerPassword, row?.password ?? '')).toBe(true)
            expect(await validatePassword(loserPassword, row?.password ?? '')).toBe(false)
        })
    })

    describe('POST /auth/logout-all', () => {
        it('revokes every session, the caller included', async () => {
            const user = await insertUser('http-logout-all')
            const a = await signedIn(user.email ?? '')
            const b = await signedIn(user.email ?? '')
            const oldCookie = a.cookie

            const reply = a.keep(await a.request('POST', '/auth/logout-all', { body: {} }))

            expect(reply.status).toBe(200)
            expect(reply.body).toMatchObject({ status: 'success', csrfToken: expect.any(String) })
            expect((await b.request('GET', '/main/init')).status).toBe(401)
            const stale = new Browser()
            stale.cookie = oldCookie
            expect((await stale.request('GET', '/main/init')).status).toBe(401)
            // The caller now holds an anonymous session.
            expect((await a.request('GET', '/main/init')).status).toBe(401)
            expect((await rowOf(user.id))?.sessionToken).not.toBe(user.sessionToken)
        })

        it('answers 503 when the cleanup fails, but every session is already revoked', async () => {
            const user = await insertUser('http-logout-all-down')
            const a = await signedIn(user.email ?? '')
            const b = await signedIn(user.email ?? '')
            cleanup.fail = true

            const reply = await a.request('POST', '/auth/logout-all', { body: {} })

            expect(reply.status).toBe(503)
            expect(reply.body).toMatchObject({ status: 'error', code: 'service_unavailable' })
            expect(reply.headers.get('retry-after')).toBe('1')
            cleanup.fail = false
            expect((await b.request('GET', '/main/init')).status).toBe(401)
            // A cannot repeat the request: its session is revoked too.
            expect((await a.request('GET', '/main/init')).status).toBe(401)
        })
    })

    describe('POST /auth/reset-password', () => {
        it('succeeds and revokes the sessions when the Redis cleanup fails', async () => {
            const user = await insertUser('http-reset')
            const b = await signedIn(user.email ?? '')
            const bSessionId = sessionIdOf(b)
            const rawToken = `reset-${crypto.randomUUID()}`
            const created = await passwordResetRepository.create({
                userId: user.id,
                tokenHash: createHash('sha256').update(rawToken).digest('hex'),
                expiresAt: new Date(Date.now() + 60_000),
            })
            const visitor = new Browser()
            await visitor.init() // anonymous session and its CSRF token
            cleanup.fail = true

            const reply = await visitor.request('POST', '/auth/reset-password', {
                body: {
                    token: rawToken,
                    password: 'reset-secret-789',
                    passwordConfirm: 'reset-secret-789',
                },
            })

            // The reset went through and the token is spent (a failed cleanup used to
            // return an error before it was marked used).
            expect(reply.status).toBe(200)
            expect(reply.body).toMatchObject({ status: 'success' })
            const [token] = await db
                .select()
                .from(passwordResetTokens)
                .where(eq(passwordResetTokens.id, created.id))
            expect(token?.usedAt).not.toBeNull()
            const row = await rowOf(user.id)
            expect(await validatePassword('reset-secret-789', row?.password ?? '')).toBe(true)

            // B's record is still in Redis, but its next request is already refused.
            expect(await getSession(bSessionId, user.sessionToken)).not.toBeNull()
            cleanup.fail = false
            expect((await b.request('GET', '/main/init')).status).toBe(401)
        })
    })

    describe('when the database cannot answer', () => {
        it('answers 503 instead of serving the Redis record, then recovers', async () => {
            const user = await insertUser('http-db-down')
            const a = await signedIn(user.email ?? '')
            vi.spyOn(userRepository, 'findSessionToken').mockRejectedValue(
                new Error('connection terminated'),
            )

            const reply = await a.request('GET', '/main/init')

            expect(reply.status).toBe(503)
            expect(reply.body).toMatchObject({ status: 'error', code: 'service_unavailable' })
            expect(reply.headers.get('retry-after')).toBe('1')
            expect(JSON.stringify(reply.body)).not.toContain('connection terminated')

            vi.restoreAllMocks()
            expect((await a.request('GET', '/main/init')).status).toBe(200)
        })

        it('answers 503 within the deadline when the lookup never answers', async () => {
            const user = await insertUser('http-db-hang')
            const a = await signedIn(user.email ?? '')
            vi.spyOn(userRepository, 'findSessionToken').mockReturnValue(
                new Promise<string>(() => undefined),
            )

            const started = Date.now()
            const reply = await a.request('GET', '/main/init')

            expect(reply.status).toBe(503)
            expect(reply.body).toMatchObject({ code: 'service_unavailable' })
            // SESSION_TOKEN_CHECK_TIMEOUT_MS is 400 in this suite.
            expect(Date.now() - started).toBeLessThan(2000)
        })
    })
})
