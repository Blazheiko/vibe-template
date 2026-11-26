import { createServer } from 'node:net'

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

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р12, Р13; tasks P4 «Відновлення акаунта лише з
// passkey», steps 1–3) over HTTP with real WebAuthn answers. An account with a verified email and
// nothing but a passkey (and its recovery codes) loses the passkey: «forgot password» sets a
// password and keeps the passkey, the codes and MFA; the password then asks for the second step;
// a recovery code opens the recovery session, which adds a new passkey (R+), removes the lost one
// (the password keeps the account reachable), makes new codes and finishes; an ordinary sign-in
// with the password and the new passkey follows. Branch B (no codes, an administrator's reset)
// belongs to feat-248 (X2).

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
const mails = vi.hoisted((): { to: string; text: string }[] => [])
vi.mock('#app/services/notifications/email-service.js', () => ({
    emailService: {
        send: (message: { to: string; text: string }) => {
            mails.push(message)
            return Promise.resolve({ status: 'ok', value: { id: 'mail' } })
        },
    },
}))
vi.mock('#app/services/auth/new-sign-in-notice.js', async (importActual) => {
    const actual = await importActual<Record<string, unknown>>()
    return { ...actual, notifyNewSignIn: newSignIn }
})

describe.skipIf(!hasPg || !hasRedis)(
    'recovery of a passkey-only account (feat-246 P4)',
    async () => {
        const { db, pool } = await import('#database/db.js')
        const { sessionCheckPool } = await import('#database/session-check-db.js')
        const { users, mfaRecoveryCodes } = await import('#database/schema.js')
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

            async request(
                method: 'GET' | 'POST' | 'DELETE',
                path: string,
                body?: unknown,
            ): Promise<Reply> {
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
                const value = Buffer.from(
                    this.cookies.get(sessionConfig.cookieName) ?? '',
                    'base64',
                )
                return value.toString().split('.')[1] ?? ''
            }
        }

        const { recoveryCodes } = await import('./recovery-codes.js')
        const { and, isNull } = await import('drizzle-orm')
        const NEW_PASSWORD = 'recovered-pass-123'

        /** A verified account with no password, one passkey (registered for real) and 10 codes. */
        const passkeyOnlyUser = async () => {
            const [row] = await db
                .insert(users)
                .values({
                    name: 'passkey-only',
                    email: `passkey-only-${crypto.randomUUID()}@example.test`,
                    emailVerifiedAt: new Date(),
                })
                .returning()
            if (row === undefined) throw new Error('user not inserted')
            createdUserIds.push(row.id)
            const authenticator = new SoftAuthenticator({ counter: 1 })
            const { randomBytes } = await import('node:crypto')
            const handle = await withTransaction((tx) =>
                webauthnCredentialRepository.ensureUserHandle(row.id, randomBytes(32), tx),
            )
            const options = await registrationOptions({
                userHandle: handle,
                userName: row.email ?? '',
                displayName: 'Passkey only',
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
            const { key, codes } = await withTransaction(async (tx) => ({
                key: await webauthnCredentialRepository.insert(
                    {
                        userId: row.id,
                        ...verified.registration,
                        name: 'Lost phone',
                        enrollmentId: crypto.randomUUID().replaceAll('-', ''),
                    },
                    tx,
                ),
                codes: await recoveryCodes.issue(row.id, tx),
            }))
            return { row, email: row.email ?? '', key, codes }
        }

        const unusedCodes = async (userId: UserId) =>
            (
                await db
                    .select()
                    .from(mfaRecoveryCodes)
                    .where(
                        and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)),
                    )
            ).length

        const passwordSignIn = async (browser: Browser, email: string) => {
            browser.keep(await browser.request('GET', '/main/init'))
            return browser.keep(
                await browser.request('POST', '/auth/login', {
                    identifier: email,
                    password: NEW_PASSWORD,
                }),
            )
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

        it('forgot password, recovery code, new passkey, lost one removed, new codes, sign in again', async () => {
            const user = await passkeyOnlyUser()

            // 1. «Forgot password»: a password is set; the passkey, the codes and MFA stay (no claim).
            const browser = new Browser()
            browser.keep(await browser.request('GET', '/main/init'))
            const forgot = await browser.request('POST', '/auth/forgot-password', {
                email: user.email,
            })
            expect(forgot.status).toBe(200)
            // The reset mail leaves after the answer (the same answer for every address).
            await vi.waitFor(() => {
                expect(mails.some((item) => item.to === user.email)).toBe(true)
            })
            const mail = mails.filter((item) => item.to === user.email).at(-1)
            const token = /reset-password\?token=([^\s&]+)/.exec(mail?.text ?? '')?.[1]
            expect(token).toBeDefined()
            const reset = await browser.request('POST', '/auth/reset-password', {
                token: decodeURIComponent(token ?? ''),
                password: NEW_PASSWORD,
                passwordConfirm: NEW_PASSWORD,
            })
            expect(reset.status).toBe(200)
            expect(await webauthnCredentialRepository.countByUserId(user.row.id)).toBe(1)
            expect(await unusedCodes(user.row.id)).toBe(10)

            // 2. The password asks for the second step: a passkey or a recovery code, no TOTP.
            const lost = new Browser()
            const first = await passwordSignIn(lost, user.email)
            expect(first.body).toMatchObject({
                status: 'mfa_required',
                methods: ['webauthn', 'recovery_code'],
            })

            // 3. Branch A: the recovery code opens the recovery session.
            const recovered = lost.keep(
                await lost.request('POST', '/auth/mfa/verify', {
                    method: 'recovery_code',
                    code: user.codes[0],
                }),
            )
            expect(recovered.status).toBe(200)
            const init = lost.keep(await lost.request('GET', '/main/init'))
            expect(init.body['recovery']).toMatchObject({ replaced: false })

            // The lost passkey cannot go before the replacement (R).
            const early = await lost.request('DELETE', `/account/passkeys/${String(user.key.id)}`)
            expect(early.status).toBe(403)

            // A new passkey: the replacement (R+).
            const fresh = new SoftAuthenticator({ counter: 1 })
            const options = await lost.request('POST', '/account/passkeys/options', {})
            expect(options.status).toBe(200)
            const opts = options.body['options'] as { challenge: string; user: { id: string } }
            const registered = await lost.request('POST', '/account/passkeys', {
                enrollmentId: options.body['enrollmentId'],
                name: 'New phone',
                response: fresh.register({
                    challenge: opts.challenge,
                    rpId: RP,
                    origin: WEB_ORIGIN,
                    userHandle: opts.user.id,
                }),
            })
            expect(registered.status).toBe(200)
            expect(
                (
                    lost.keep(await lost.request('GET', '/main/init')).body['recovery'] as {
                        replaced: boolean
                    }
                ).replaced,
            ).toBe(true)

            // The lost one goes; the password keeps the account reachable.
            const removed = await lost.request('DELETE', `/account/passkeys/${String(user.key.id)}`)
            expect(removed.status).toBe(200)
            expect(removed.body).toMatchObject({ mfaDisabled: false })

            // New codes, then the recovery ends.
            const codes = await lost.request('POST', '/account/mfa/recovery-codes', {})
            expect(codes.status).toBe(200)
            expect(codes.body['recoveryCodes']).toHaveLength(10)
            expect((await lost.request('POST', '/auth/recovery/finish', {})).status).toBe(200)

            // An ordinary sign-in: the password and the new passkey.
            const again = new Browser()
            const second = await passwordSignIn(again, user.email)
            expect(second.body).toMatchObject({ status: 'mfa_required' })
            const step = await again.request('POST', '/auth/mfa/webauthn/options', {})
            const challenge = (step.body['options'] as { challenge: string }).challenge
            const signedIn = again.keep(
                await again.request('POST', '/auth/mfa/verify', {
                    method: 'webauthn',
                    response: fresh.authenticate({ challenge, rpId: RP, origin: WEB_ORIGIN }),
                }),
            )
            expect(signedIn.status).toBe(200)
            const session = await getSession(
                again.sessionId(),
                (await db.select().from(users).where(eq(users.id, user.row.id)))[0]?.sessionToken ??
                    '',
            )
            expect(session?.data.auth).toMatchObject({ aal: 2, amr: ['pwd', 'webauthn'] })
            expect(session?.data.auth?.recovery).toBeUndefined()
        })
    },
)
