import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'

import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Role } from 'shared/access'
import type { StaffFactorMode } from 'shared/mfa'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../../test-support/redis-test-client.js'
import { SoftAuthenticator } from '../../../../test-support/soft-authenticator.js'
import { enrollTestTotp, type TestTotp } from '../../../../test-support/test-totp.js'
import type { UserId } from '#app/domain/ids.js'

// feat-248 (docs/plan/passkeys-mfa-plan.md, Р10, Р12, Р13, Д11; tasks X2) over HTTP with the real
// route table, session_web, csrf_guard, auth_guard and can:, a real PostgreSQL and Redis, and real
// WebAuthn answers (a software authenticator):
// - a staff role over HTTP in both modes of MFA_STAFF_FACTOR: `any` gives it to a TOTP-only
//   account; `passkey` refuses an admin signed in with TOTP (403 mfa_session_required), and from
//   a passkey session refuses the TOTP-only account (409 mfa_not_enrolled) until it has a passkey;
// - branch B of Р12 for an account with a verified email and nothing but a passkey (no recovery
//   codes) that lost the passkey: the reset before a password exists is refused with
//   last_sign_in_method; «forgot password» sets one and keeps MFA; the password asks for the
//   second step; the reset then succeeds and ends the sessions; the password signs in without a
//   second step and a new factor is set up. Once by an administrator over HTTP, once by the CLI.

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
// The mode is switched per test: every consumer reads it through staffPolicy() on each call.
vi.mock('#config/mfa.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return { default: { ...actual.default, requiredForStaff: true, staffFactor: 'any' } }
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
    return { ...actual, notifyNewSignIn: vi.fn() }
})
vi.mock('#app/services/support/support-embedding-service.js', () => ({
    supportEmbeddingService: {
        indexArticle: () => Promise.resolve(true),
        reindexAll: () => Promise.resolve({ indexed: 0, failed: [] }),
    },
}))

const PASSWORD = 'staff-passkey-mode-123'
const NEW_PASSWORD = 'recovered-pass-123'

describe.skipIf(!hasPg || !hasRedis)('staff passkey mode over HTTP (feat-248 X2)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, auditEvents } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { hashPassword } = await import('metautil')
    const { default: webauthnConfig } = await import('#config/webauthn.js')
    const { default: mfaConfig } = (await import('#config/mfa.js')) as unknown as {
        default: { staffFactor: StaffFactorMode }
    }
    const { webauthnCredentialRepository, withTransaction } =
        await import('#app/repositories/index.js')
    const { registrationOptions, verifyWebAuthnCeremony, ceremonyBinding } =
        await import('./webauthn-ceremony.js')
    const { loadMfaFactors } = await import('./mfa-account.js')
    const { runUserMfaReset } = await import('../../../../scripts/user-mfa-reset-cli.js')

    await import('#app/start/index.js')

    const redisAdmin = createTestRedis(PREFIX)
    const createdUserIds: UserId[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined
    const RP = webauthnConfig.rpId
    const WEB_ORIGIN = webauthnConfig.origins[0] ?? ''

    interface Reply {
        status: number
        body: Record<string, unknown>
    }

    class Browser {
        cookies = new Map<string, string>()
        csrf: string | undefined

        async request(
            method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
            for (const line of response.headers.getSetCookie()) {
                const [pair = ''] = line.split(';')
                const index = pair.indexOf('=')
                const value = pair.slice(index + 1)
                if (value === '') this.cookies.delete(pair.slice(0, index))
                else this.cookies.set(pair.slice(0, index), value)
            }
            const parsed = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>
            if (typeof parsed['csrfToken'] === 'string') this.csrf = parsed['csrfToken']
            return { status: response.status, body: parsed }
        }

        /** The password step; answers `mfa_required` when the account has a second factor. */
        async password(email: string, password = PASSWORD): Promise<Reply> {
            await this.request('GET', '/main/init')
            return this.request('POST', '/auth/login', { identifier: email, password })
        }

        async totpStep(totp: TestTotp): Promise<Reply> {
            return this.request('POST', '/auth/mfa/verify', { method: 'totp', code: totp.code() })
        }

        async passkeyStep(authenticator: SoftAuthenticator): Promise<Reply> {
            const options = await this.request('POST', '/auth/mfa/webauthn/options', {})
            const challenge = (options.body['options'] as { challenge: string }).challenge
            return this.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: authenticator.authenticate({ challenge, rpId: RP, origin: WEB_ORIGIN }),
            })
        }
    }

    const insertUser = async (
        role: Role,
        fields: { password?: boolean; name?: string } = {},
    ): Promise<{ id: UserId; email: string }> => {
        const [row] = await db
            .insert(users)
            .values({
                name: fields.name ?? 'staff-passkey',
                email: `staff-passkey-${crypto.randomUUID()}@example.test`,
                password: fields.password === false ? null : await hashPassword(PASSWORD),
                emailVerifiedAt: new Date(),
                role,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return { id: row.id, email: row.email ?? '' }
    }

    /** A passkey registered for real (the ceremony of the service), stored without codes. */
    const addPasskey = async (user: { id: UserId; email: string }) => {
        const authenticator = new SoftAuthenticator({ counter: 1 })
        const handle = await withTransaction((tx) =>
            webauthnCredentialRepository.ensureUserHandle(user.id, randomBytes(32), tx),
        )
        const options = await registrationOptions({
            userHandle: handle,
            userName: user.email,
            displayName: 'Staff',
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
        await withTransaction((tx) =>
            webauthnCredentialRepository.insert(
                {
                    userId: user.id,
                    ...verified.registration,
                    name: 'Phone',
                    enrollmentId: crypto.randomUUID().replaceAll('-', ''),
                },
                tx,
            ),
        )
        return authenticator
    }

    /** An administrator with TOTP signed in with it (the `any` mode). */
    const totpAdmin = async () => {
        const admin = await insertUser('admin', { name: 'totp admin' })
        const totp = await enrollTestTotp(admin.id)
        const browser = new Browser()
        expect((await browser.password(admin.email)).body).toMatchObject({
            status: 'mfa_required',
        })
        expect((await browser.totpStep(totp)).status).toBe(200)
        return { admin, browser }
    }

    beforeAll(async () => {
        await redisAdmin.connect()
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
        mfaConfig.staffFactor = 'any'
    })

    afterAll(async () => {
        await stopServer?.('test')
        for (const id of createdUserIds) {
            await db.delete(auditEvents).where(eq(auditEvents.targetUserId, id))
            await db.delete(auditEvents).where(eq(auditEvents.actorUserId, id))
            await db.delete(users).where(eq(users.id, id))
        }
        await cleanupTestRedis(redisAdmin)
        redisHealth.stop()
        redisClient.disconnect(false)
        await redisAdmin.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    const roleOf = async (id: UserId): Promise<Role | undefined> =>
        (await db.select({ role: users.role }).from(users).where(eq(users.id, id)))[0]?.role

    describe('a staff role over HTTP in both modes', () => {
        it('any: a TOTP-only account gets the role', async () => {
            const { browser } = await totpAdmin()
            const target = await insertUser('user')
            await enrollTestTotp(target.id)

            const reply = await browser.request('PATCH', `/admin/users/${String(target.id)}/role`, {
                role: 'kb_editor',
            })

            expect(reply.status).toBe(200)
            expect(await roleOf(target.id)).toBe('kb_editor')
        })

        it('passkey: a TOTP session is refused; from a passkey session the TOTP-only account is refused until it has a passkey', async () => {
            mfaConfig.staffFactor = 'passkey'
            const admin = await insertUser('admin', { name: 'passkey admin' })
            const totp = await enrollTestTotp(admin.id)
            const key = await addPasskey(admin)
            const target = await insertUser('user')
            await enrollTestTotp(target.id)
            const path = `/admin/users/${String(target.id)}/role`

            // Signed in with TOTP: the admin area refuses the session, the account is enrolled.
            const byTotp = new Browser()
            await byTotp.password(admin.email)
            expect((await byTotp.totpStep(totp)).status).toBe(200)
            const refused = await byTotp.request('PATCH', path, { role: 'kb_editor' })
            expect(refused.status).toBe(403)
            expect(refused.body).toMatchObject({ reason: 'mfa_session_required' })
            // The security section tells the client which factor the role needs.
            const status = await byTotp.request('GET', '/account/mfa')
            expect(status.body).toMatchObject({ staffFactor: 'passkey', passkeys: 1 })

            // Signed in with the passkey: the TOTP-only target is not enrolled for this mode.
            const byPasskey = new Browser()
            await byPasskey.password(admin.email)
            expect((await byPasskey.passkeyStep(key)).status).toBe(200)
            const notEnrolled = await byPasskey.request('PATCH', path, { role: 'kb_editor' })
            expect(notEnrolled.status).toBe(409)
            expect(notEnrolled.body).toMatchObject({ reason: 'mfa_not_enrolled' })
            expect(await roleOf(target.id)).toBe('user')

            await addPasskey(target)
            const given = await byPasskey.request('PATCH', path, { role: 'kb_editor' })
            expect(given.status).toBe(200)
            expect(await roleOf(target.id)).toBe('kb_editor')
        })
    })

    /** Branch B of Р12 up to the reset: returns the account and an open session of it. */
    type Reset = (user: { id: UserId; email: string }) => Promise<{ ok: boolean; reason?: string }>
    const branchBUntilReset = async (reset: Reset) => {
        // P4 without codes: a verified email and nothing but a passkey.
        const user = await insertUser('user', { password: false, name: 'passkey only' })
        const key = await addPasskey(user)

        // The reset before a password exists would leave no way in: refused, without exception.
        expect(await reset(user)).toEqual({ ok: false, reason: 'last_sign_in_method' })
        expect((await loadMfaFactors(user.id)).passkeys).toBe(1)

        // «Forgot password» sets a password; MFA stays (a verified account, no claim).
        const browser = new Browser()
        await browser.request('GET', '/main/init')
        expect(
            (await browser.request('POST', '/auth/forgot-password', { email: user.email })).status,
        ).toBe(200)
        await vi.waitFor(() => {
            expect(mails.some((item) => item.to === user.email)).toBe(true)
        })
        const mail = mails.filter((item) => item.to === user.email).at(-1)
        const token = /reset-password\?token=([^\s&]+)/.exec(mail?.text ?? '')?.[1]
        expect(token).toBeDefined()
        const changed = await browser.request('POST', '/auth/reset-password', {
            token: decodeURIComponent(token ?? ''),
            password: NEW_PASSWORD,
            passwordConfirm: NEW_PASSWORD,
        })
        expect(changed.status).toBe(200)
        expect((await loadMfaFactors(user.id)).passkeys).toBe(1)

        // The password asks for the second step: a passkey (the account has no TOTP).
        const lost = new Browser()
        const second = await lost.password(user.email, NEW_PASSWORD)
        expect(second.body).toMatchObject({ status: 'mfa_required' })
        expect(second.body['methods']).toContain('webauthn')
        expect(second.body['methods']).not.toContain('totp')

        // A session still open somewhere (signed in with the passkey before it was lost).
        const open = new Browser()
        await open.password(user.email, NEW_PASSWORD)
        expect((await open.passkeyStep(key)).status).toBe(200)
        expect((await open.request('GET', '/account/mfa')).status).toBe(200)

        return { user, open }
    }

    /** Branch B of Р12 after a successful reset. */
    const branchBAfterReset = async (
        user: { id: UserId; email: string },
        open: Browser,
    ): Promise<void> => {
        expect(await loadMfaFactors(user.id)).toEqual({ totp: undefined, passkeys: 0 })
        // Every session ended (the token rotated, the records went).
        expect((await open.request('GET', '/account/mfa')).status).toBe(401)

        // The password signs in without a second step, and a new factor can be set up (row 1).
        const again = new Browser()
        expect((await again.password(user.email, NEW_PASSWORD)).body).toMatchObject({
            status: 'success',
        })
        const fresh = new SoftAuthenticator({ counter: 1 })
        const options = await again.request('POST', '/account/passkeys/options', {})
        expect(options.status).toBe(200)
        const opts = options.body['options'] as { challenge: string; user: { id: string } }
        const registered = await again.request('POST', '/account/passkeys', {
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
        expect(registered.body['recoveryCodes']).toHaveLength(10)
        expect((await loadMfaFactors(user.id)).passkeys).toBe(1)
    }

    it('branch B: an administrator resets a passkey-only account after «forgot password»', async () => {
        const { browser: admin } = await totpAdmin()
        const reset: Reset = async (target) => {
            const reply = await admin.request(
                'POST',
                `/admin/users/${String(target.id)}/mfa/reset`,
                { reason: 'lost the only passkey' },
            )
            return reply.status === 200
                ? { ok: true }
                : { ok: false, reason: reply.body['reason'] as string }
        }
        const { user, open } = await branchBUntilReset(reset)

        expect(await reset(user)).toEqual({ ok: true })
        await branchBAfterReset(user, open)
    })

    it('branch B: the same through the CLI user:mfa-reset', async () => {
        const reset: Reset = async (target) => {
            const errors: string[] = []
            const code = await runUserMfaReset(
                ['--email', target.email, '--reason', 'lost the only passkey'],
                { print: () => undefined, printError: (line) => errors.push(line) },
            )
            if (code === 0) return { ok: true }
            const reason = /\(([a-z_]+)\)/.exec(errors[0] ?? '')?.[1]
            return { ok: false, ...(reason !== undefined ? { reason } : {}) }
        }
        const { user, open } = await branchBUntilReset(reset)

        expect(await reset(user)).toEqual({ ok: true })
        await branchBAfterReset(user, open)
    })
})
