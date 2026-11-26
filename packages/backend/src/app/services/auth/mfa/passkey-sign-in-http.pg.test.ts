import { createServer } from 'node:net'
import type { NormalizedEmail } from '#app/domain/email.js'

import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../../test-support/redis-test-client.js'
import { SoftAuthenticator } from '../../../../test-support/soft-authenticator.js'
import type { UserId } from '#app/domain/ids.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6, tasks P3) over HTTP: a real uWebSockets.js server
// with the real routes and session layer, a real PostgreSQL and Redis, and real WebAuthn answers
// (a software authenticator). A passkey alone signs in at level 2 without a second step; an
// unknown key, a bad signature, another account's handle, a spent challenge and a counter that
// went back all answer the same 401, and the regression is recorded for the owner.

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
    process.env['MFA_ENCRYPTION_KEYS'] = `k1:${Buffer.alloc(32, 5).toString('base64')}`
    process.env['AUTH_OTP_HMAC_KEY'] ??= 'o'.repeat(32)
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
const security = vi.hoisted(() => vi.fn())
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security, supportReply: vi.fn() },
}))
const newSignIn = vi.hoisted(() => vi.fn())
vi.mock('#app/services/auth/new-sign-in-notice.js', async (importActual) => {
    const actual = await importActual<Record<string, unknown>>()
    return { ...actual, notifyNewSignIn: newSignIn }
})

describe.skipIf(!hasPg || !hasRedis)('passwordless sign-in over HTTP (feat-246 P3)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, auditEvents } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { default: webauthnConfig } = await import('#config/webauthn.js')
    const { getSession } = await import('#vendor/utils/session/redis-session-storage.js')
    const { default: sessionConfig } = await import('#config/session.js')
    const { webauthnCredentialRepository, withTransaction } =
        await import('#app/repositories/index.js')
    const { registrationOptions, verifyWebAuthnCeremony, ceremonyBinding } =
        await import('./webauthn-ceremony.js')

    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const createdUserIds: UserId[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined
    const RP = webauthnConfig.rpId
    const WEB_ORIGIN = webauthnConfig.origins[0] ?? ''

    interface Reply {
        status: number
        body: Record<string, unknown>
        cookies: Map<string, string>
    }

    class Browser {
        cookies = new Map<string, string>()
        csrf: string | undefined

        async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
            const headers: Record<string, string> = { origin: ORIGIN }
            if (this.cookies.size > 0) {
                headers['cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
            }
            if (this.csrf !== undefined) headers['x-csrf-token'] = this.csrf
            if (body !== undefined) headers['content-type'] = 'application/json'
            const response = await fetch(`http://127.0.0.1:${String(PORT)}/api${path}`, {
                method,
                headers,
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            })
            const text = await response.text()
            const cookies = new Map<string, string>()
            for (const line of response.headers.getSetCookie()) {
                const [pair] = line.split(';')
                const index = (pair ?? '').indexOf('=')
                cookies.set((pair ?? '').slice(0, index), (pair ?? '').slice(index + 1))
            }
            return {
                status: response.status,
                body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
                cookies,
            }
        }

        keep(reply: Reply): Reply {
            for (const [name, value] of reply.cookies) {
                if (value === '') this.cookies.delete(name)
                else this.cookies.set(name, value)
            }
            if (typeof reply.body['csrfToken'] === 'string') this.csrf = reply.body['csrfToken']
            return reply
        }

        sessionId(): string {
            const value = Buffer.from(this.cookies.get(sessionConfig.cookieName) ?? '', 'base64')
            return value.toString().split('.')[1] ?? ''
        }
    }

    /** A verified account with one passkey, registered through the real ceremony. */
    const passkeyUser = async (name: string, counter = 0) => {
        const [row] = await db
            .insert(users)
            .values({
                name,
                email: `${name}-${crypto.randomUUID()}@example.test` as NormalizedEmail,
                emailVerifiedAt: new Date(),
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        const authenticator = new SoftAuthenticator({ counter })
        const { randomBytes } = await import('node:crypto')
        const handle = await withTransaction((tx) =>
            webauthnCredentialRepository.ensureUserHandle(row.id, randomBytes(32), tx),
        )
        const options = await registrationOptions({
            userHandle: handle,
            userName: row.email ?? '',
            displayName: name,
            exclude: [],
        })
        const binding = ceremonyBinding('register', 'test')
        const verified = await verifyWebAuthnCeremony({
            purpose: 'register',
            stored: { challenge: options.challenge, binding },
            expectedBinding: binding,
            response: authenticator.register({
                challenge: options.challenge,
                rpId: RP,
                origin: WEB_ORIGIN,
                userHandle: options.user.id,
            }),
        })
        if (!verified.ok || !('registration' in verified)) throw new Error('not registered')
        const key = await withTransaction((tx) =>
            webauthnCredentialRepository.insert(
                {
                    userId: row.id,
                    ...verified.registration,
                    name: 'Key',
                    enrollmentId: crypto.randomUUID().replaceAll('-', ''),
                },
                tx,
            ),
        )
        return { row, authenticator, key }
    }

    /** The options of a passwordless sign-in, answered by `authenticator`. */
    const signIn = async (
        browser: Browser,
        authenticator: SoftAuthenticator,
        change: { userHandle?: Buffer | null; counter?: number; origin?: string } = {},
    ) => {
        browser.keep(await browser.request('GET', '/main/init'))
        const options = await browser.request('POST', '/auth/passkey/options', {})
        expect(options.status).toBe(200)
        const challengeId = options.body['challengeId'] as string
        const challenge = (options.body['options'] as { challenge: string }).challenge
        const response = authenticator.authenticate({
            challenge,
            rpId: RP,
            origin: change.origin ?? WEB_ORIGIN,
            ...(change.userHandle !== undefined ? { userHandle: change.userHandle } : {}),
            ...(change.counter !== undefined ? { counter: change.counter } : {}),
        })
        const reply = browser.keep(
            await browser.request('POST', '/auth/passkey/verify', { challengeId, response }),
        )
        return { reply, challengeId, response }
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
        security.mockClear()
        newSignIn.mockClear()
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

    it('a passkey alone signs in at level 2 with no second step; the use is recorded', async () => {
        const user = await passkeyUser('pk-happy', 3)
        const browser = new Browser()
        const { reply } = await signIn(browser, user.authenticator)
        expect(reply.status).toBe(200)
        expect(reply.body).toMatchObject({ status: 'success', user: { id: String(user.row.id) } })
        const stored = await getSession(browser.sessionId(), user.row.sessionToken)
        expect(stored?.data.auth).toMatchObject({ aal: 2, amr: ['webauthn'] })
        expect(stored?.data.device).toMatchObject({ method: 'passkey' })
        const [key] = await webauthnCredentialRepository.listByUserId(user.row.id)
        expect(key?.signCount).toBe(4n)
        expect(key?.lastUsedAt).not.toBeNull()
        expect(newSignIn).toHaveBeenCalledOnce()
    })

    it('an unknown key and a bad signature answer the same 401', async () => {
        const user = await passkeyUser('pk-refused')
        const unknown = await signIn(new Browser(), new SoftAuthenticator())
        const foreignOrigin = await signIn(new Browser(), user.authenticator, {
            origin: 'https://evil.test',
        })
        expect(unknown.reply.status).toBe(401)
        expect(foreignOrigin.reply.status).toBe(401)
        expect(unknown.reply.body['message']).toBe(foreignOrigin.reply.body['message'])
    })

    it("a key answered with another account's user handle is refused", async () => {
        const user = await passkeyUser('pk-handle')
        const { reply } = await signIn(new Browser(), user.authenticator, {
            userHandle: Buffer.alloc(32, 255),
        })
        expect(reply.status).toBe(401)
    })

    it('a challenge answers once: the same answer again is refused', async () => {
        const user = await passkeyUser('pk-once')
        const browser = new Browser()
        const first = await signIn(browser, user.authenticator)
        expect(first.reply.status).toBe(200)
        const other = new Browser()
        other.keep(await other.request('GET', '/main/init'))
        const again = await other.request('POST', '/auth/passkey/verify', {
            challengeId: first.challengeId,
            response: first.response,
        })
        expect(again.status).toBe(401)
    })

    it('a counter that went back is refused and recorded; the key stays', async () => {
        const user = await passkeyUser('pk-clone', 10)
        expect((await signIn(new Browser(), user.authenticator)).reply.status).toBe(200)
        const cloned = await signIn(new Browser(), user.authenticator, { counter: 5 })
        expect(cloned.reply.status).toBe(401)
        const events = (
            await db.select().from(auditEvents).where(eq(auditEvents.targetUserId, user.row.id))
        ).filter((event) => event.action === 'auth.passkey.counter_regressed')
        expect(events).toHaveLength(1)
        expect(events[0]?.metadata).toMatchObject({ method: 'login', proof: 'passkey' })
        expect(await webauthnCredentialRepository.countByUserId(user.row.id)).toBe(1)
    })
})
