import { and, eq } from 'drizzle-orm'
import type { NormalizedEmail } from '#app/domain/email.js'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../../test-support/redis-test-client.js'
import { testRequest } from '../../../../test-support/audit-actor.js'
import type { UserId } from '#app/domain/ids.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4, row 16 of Р3, Р9, tasks M8) on a real PostgreSQL
// and Redis, with the real session layer: an OAuth sign-in of an account with a second factor
// opens a ticket; a link the sign-in decided (Google proving the address of a verified account)
// is written only by the second step, and not at all when the second step is a recovery code; a
// claim of an unverified address removes the factors. The provider is stubbed.

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['MFA_ENCRYPTION_KEYS'] = `k1:${Buffer.alloc(32, 3).toString('base64')}`
    process.env['AUTH_OTP_HMAC_KEY'] ??= 'o'.repeat(32)
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
vi.mock('#app/services/notifications/email-service.js', async () => {
    const { Result: R } = await import('better-result')
    return { emailService: { send: () => Promise.resolve(R.ok({ id: 'mail' })) } }
})
vi.mock('#config/oauth.js', () => ({
    default: {
        google: { clientId: 'g', clientSecret: 'g', redirectUri: 'https://app.test/g' },
        facebook: { clientId: 'f', clientSecret: 'f', redirectUri: 'https://app.test/f' },
        github: { clientId: 'h', clientSecret: 'h', redirectUri: 'https://app.test/h' },
        gitlab: { clientId: 'l', clientSecret: 'l', redirectUri: 'https://app.test/l' },
        frontendSuccessUrl: '/?oauth=success',
        frontendErrorUrl: '/?error=oauth_failed',
        frontendLinkPendingUrl: '/?oauth=link_pending',
        frontendMfaUrl: '/login?mfa=required',
    },
}))
vi.mock('arctic', () => {
    const tokens = { accessToken: () => 'provider-access-token' }
    class Client {
        validateAuthorizationCode = () => Promise.resolve(tokens)
        createAuthorizationURL = () => new URL('https://provider.test/authorize')
    }
    return {
        Google: Client,
        Facebook: Client,
        GitHub: Client,
        GitLab: Client,
        generateState: () => 'state',
        generateCodeVerifier: () => 'verifier',
    }
})

describe.skipIf(!hasPg || !hasRedis)(
    'OAuth sign-in with a second factor (feat-245 M8)',
    async () => {
        const { db, pool } = await import('#database/db.js')
        const { sessionCheckPool } = await import('#database/session-check-db.js')
        const { users, oauthAccounts, totpFactors, mfaRecoveryCodes, webauthnCredentials } =
            await import('#database/schema.js')
        const { default: redisClient, redisHealth } =
            (await import('#database/redis.js')) as unknown as {
                default: Redis
                redisHealth: { stop(): void }
            }
        const { default: sessionConfig } = await import('#config/session.js')
        const { default: createContext } = await import('#vendor/utils/context/http-context.js')
        const { createResponseData } = await import('#vendor/utils/network/response-data.js')
        const { default: executeMiddlewares } =
            await import('#vendor/utils/middlewares/core/execute-httpMiddlewares.js')
        const { mfaTicketCookieName } = await import('#vendor/utils/session/request-session.js')
        const { oauthService } = await import('#app/services/auth/oauth-service.js')
        const { completeSecondStep } = await import('./mfa-sign-in.js')
        const { totpFactorRepository, withTransaction } = await import('#app/repositories/index.js')
        const { recoveryCodes } = await import('./recovery-codes.js')
        const { mfaSecretBox, totpSecretOwner } = await import('./mfa-secret-box.js')
        const { generateTotpSecret, hotp, totpStepAt } = await import('./totp.js')
        await import('#app/start/index.js')

        const admin = createTestRedis(PREFIX)
        const created: UserId[] = []

        beforeAll(async () => {
            await admin.connect()
            await redisClient.connect()
        })
        afterEach(() => {
            vi.unstubAllGlobals()
        })
        afterAll(async () => {
            for (const id of created) await db.delete(users).where(eq(users.id, id))
            await cleanupTestRedis(admin)
            redisHealth.stop()
            redisClient.disconnect(false)
            await admin.quit()
            await sessionCheckPool.end()
            await pool.end()
        })

        /** A request of one browser through session_web: its cookies in, the reply's cookies out. */
        const request = async (cookies: Map<string, string>) => {
            const responseData = createResponseData()
            const context = createContext(
                {
                    method: 'post',
                    ip: '127.0.0.1',
                    params: {},
                    payload: {},
                    query: null,
                    headers: new Map([['user-agent', 'test-browser']]),
                    contentType: 'application/json',
                    cookies,
                    isJson: true,
                    files: null,
                    hasFile: () => false,
                } as never,
                responseData,
            )
            await executeMiddlewares(['session_web'], context)
            const keep = (): void => {
                for (const [name, cookie] of responseData.cookies) {
                    const value = (cookie as { value: string }).value
                    if (value === '') cookies.delete(name)
                    else cookies.set(name, value)
                }
            }
            return { context, keep }
        }

        const google = (profile: { id: string; email: string }): void => {
            vi.stubGlobal(
                'fetch',
                vi.fn(() =>
                    Promise.resolve({
                        ok: true,
                        status: 200,
                        json: () =>
                            Promise.resolve({
                                id: profile.id,
                                email: profile.email as NormalizedEmail,
                                name: 'Google Person',
                                verified_email: true,
                            }),
                    }),
                ),
            )
        }

        const mfaAccount = async (verified: boolean) => {
            const email = `mfa-oauth-${crypto.randomUUID()}@gmail.com` as NormalizedEmail
            const [row] = await db
                .insert(users)
                .values({ name: 'mfa-oauth', email, emailVerifiedAt: verified ? new Date() : null })
                .returning()
            if (row === undefined) throw new Error('user not inserted')
            created.push(row.id)
            const secret = generateTotpSecret()
            const box = mfaSecretBox()
            if (box === null) throw new Error('no MFA key')
            const sealed = box.seal(secret, totpSecretOwner(row.id))
            const codes = await withTransaction(async (tx) => {
                await totpFactorRepository.replace(
                    {
                        userId: row.id,
                        enrollmentId: crypto.randomUUID().slice(0, 32),
                        secretCiphertext: sealed.ciphertext,
                        keyId: sealed.keyId,
                        lastUsedStep: 0n,
                        confirmedAt: new Date(),
                    },
                    tx,
                )
                return recoveryCodes.issue(row.id, tx)
            })
            return { row, email, code: () => hotp(secret, totpStepAt(Date.now())), codes }
        }

        const linksOf = (userId: UserId) =>
            db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId))

        const callback = async (cookies: Map<string, string>) => {
            const { context, keep } = await request(cookies)
            const result = await oauthService.handleCallback(
                'google',
                'code',
                'st',
                'st',
                'cv',
                context.auth,
                context.session.sessionInfo?.id ?? null,
                testRequest(),
            )
            keep()
            return result
        }

        const verify = async (
            cookies: Map<string, string>,
            input: { method: 'totp' | 'recovery_code'; code: string },
        ) => {
            const { context, keep } = await request(cookies)
            const result = await completeSecondStep(
                { auth: context.auth, session: context.session },
                input,
                testRequest(),
            )
            keep()
            return result
        }

        it('Google proving a verified account with TOTP: a ticket, the link only after the code', async () => {
            const user = await mfaAccount(true)
            google({ id: `g-${crypto.randomUUID()}`, email: user.email })
            const browser = new Map<string, string>()
            const result = await callback(browser)
            expect(result.status).toBe('ok')
            if (result.status === 'ok')
                expect(result.value.redirectUrl).toBe(
                    '/login?mfa=required&methods=totp,recovery_code',
                )
            expect(browser.has(mfaTicketCookieName())).toBe(true)
            expect(await linksOf(user.row.id)).toEqual([])

            const signedIn = await verify(browser, { method: 'totp', code: user.code() })
            expect(signedIn.status).toBe('ok')
            expect((await linksOf(user.row.id)).map((link) => link.provider)).toEqual(['google'])
            expect(browser.has(sessionConfig.cookieName)).toBe(true)
        })

        it('the same with a recovery code: signed in to a recovery session, no link made', async () => {
            const user = await mfaAccount(true)
            google({ id: `g-${crypto.randomUUID()}`, email: user.email })
            const browser = new Map<string, string>()
            await callback(browser)
            const signedIn = await verify(browser, {
                method: 'recovery_code',
                code: user.codes[0] ?? '',
            })
            expect(signedIn.status).toBe('ok')
            expect(await linksOf(user.row.id)).toEqual([])
        })

        it('a sign-in by an identity already linked asks for the second step', async () => {
            const user = await mfaAccount(true)
            const id = `g-${crypto.randomUUID()}`
            await db.insert(oauthAccounts).values({
                userId: user.row.id,
                provider: 'google',
                providerUserId: id,
                providerEmail: user.email,
                createdAt: new Date(),
                updatedAt: new Date(),
            })
            google({ id, email: user.email })
            const browser = new Map<string, string>()
            const result = await callback(browser)
            if (result.status === 'ok')
                expect(result.value.redirectUrl).toBe(
                    '/login?mfa=required&methods=totp,recovery_code',
                )
            expect(browser.has(sessionConfig.cookieName)).toBe(true)
            const signedIn = await verify(browser, { method: 'totp', code: user.code() })
            expect(signedIn.status).toBe('ok')
        })

        it('a claim of an unverified address removes the factors and signs in without a second step', async () => {
            const user = await mfaAccount(false)
            // feat-246 (Р9): a passkey and the WebAuthn user handle go with the other factors.
            await db
                .update(users)
                .set({ webauthnUserHandle: Buffer.alloc(32, 5) })
                .where(eq(users.id, user.row.id))
            await db.insert(webauthnCredentials).values({
                userId: user.row.id,
                credentialId: Buffer.from(crypto.randomUUID()),
                publicKey: Buffer.from([1]),
                deviceType: 'singleDevice',
                backedUp: false,
                name: 'Key',
                enrollmentId: crypto.randomUUID().replaceAll('-', ''),
            })
            google({ id: `g-${crypto.randomUUID()}`, email: user.email })
            const browser = new Map<string, string>()
            const result = await callback(browser)
            if (result.status === 'ok') expect(result.value.redirectUrl).toBe('/?oauth=success')
            expect(browser.has(mfaTicketCookieName())).toBe(false)
            expect(
                await db.select().from(totpFactors).where(eq(totpFactors.userId, user.row.id)),
            ).toEqual([])
            expect(
                await db
                    .select()
                    .from(mfaRecoveryCodes)
                    .where(and(eq(mfaRecoveryCodes.userId, user.row.id))),
            ).toEqual([])
            expect(
                await db
                    .select()
                    .from(webauthnCredentials)
                    .where(eq(webauthnCredentials.userId, user.row.id)),
            ).toEqual([])
            const [after] = await db
                .select({ handle: users.webauthnUserHandle })
                .from(users)
                .where(eq(users.id, user.row.id))
            expect(after?.handle).toBeNull()
            expect((await linksOf(user.row.id)).map((link) => link.provider)).toEqual(['google'])
        })
    },
)
