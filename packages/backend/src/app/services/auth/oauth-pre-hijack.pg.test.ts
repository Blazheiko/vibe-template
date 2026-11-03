import { createHash } from 'node:crypto'

import { Result } from 'better-result'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-097: account pre-hijacking through OAuth, against a real PostgreSQL. The paths are
// those of docs/plan/oauth-pre-hijack-plan.md («Шляхи атаки»): an attacker prepares an
// account with the victim's address; after the fix, every way of keeping access to it ends
// when the owner proves the mailbox. Providers, mail, push and Redis are stubbed.

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
const mail = vi.hoisted(() => ({ sent: [] as { to: string; text: string }[] }))
const destroyed = vi.hoisted(() => ({ tokens: [] as string[] }))

vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: (token: string) => {
        destroyed.tokens.push(token)
        return Promise.resolve(0)
    },
}))
vi.mock('#app/services/notifications/email-service.js', async () => {
    const { Result: R } = await import('better-result')
    return {
        emailService: {
            send: (message: { to: string; text: string }) => {
                mail.sent.push({ to: message.to, text: message.text })
                return Promise.resolve(R.ok({ id: 'mail' }))
            },
        },
    }
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

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

describe.skipIf(!hasPg)('OAuth pre-hijacking on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const schema = await import('#database/schema.js')
    const { users, oauthAccounts, pushSubscriptions, emailLinkVerifications } = schema
    const { oauthLinkVerifications, emailVerifications } = schema
    const { oauthAccountRepository, emailLinkVerificationRepository } =
        await import('#app/repositories/index.js')
    const { emailVerificationRepository } = await import('#app/repositories/index.js')
    const { oauthService } = await import('#app/services/auth/oauth-service.js')
    const { emailVerificationService } =
        await import('#app/services/auth/email-verification-service.js')
    const { passwordResetService } = await import('#app/services/auth/password-reset-service.js')
    const { hashPassword } = await import('metautil')

    const now = Date.now()
    const ATTACKER_PASSWORD = 'attacker-secret-1'
    const createdUserIds: bigint[] = []
    let counter = 0

    const address = (label: string, domain = 'gmail.com'): string => {
        counter += 1
        return `victim-${label}-${String(counter)}-${String(now)}@${domain}`
    }

    /** What an attacker prepares: an unverified account with the victim's address. */
    const insertUser = async (options: {
        email: string | null
        verified?: boolean
        phone?: string
        password?: string | null
    }) => {
        const [row] = await db
            .insert(users)
            .values({
                name: `pre-hijack-${String(counter)}`,
                email: options.email,
                emailVerifiedAt: options.verified === true ? new Date() : null,
                phone: options.phone ?? null,
                password:
                    options.password === null
                        ? null
                        : await hashPassword(options.password ?? ATTACKER_PASSWORD),
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    const userRow = async (id: bigint) => {
        const [row] = await db.select().from(users).where(eq(users.id, id))
        return row
    }
    const linksOf = async (userId: bigint) =>
        db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId))

    /** The provider's profile, answered by the stubbed provider APIs. */
    const provider = (profile: {
        id: string
        email: string
        verified?: boolean
        hd?: string
    }): void => {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                const body = url.startsWith('https://www.googleapis.com/')
                    ? {
                          id: profile.id,
                          email: profile.email,
                          name: 'Google Person',
                          verified_email: profile.verified ?? true,
                          ...(profile.hd !== undefined ? { hd: profile.hd } : {}),
                      }
                    : { id: profile.id, email: profile.email, name: 'Facebook Person' }
                return Promise.resolve({ json: () => Promise.resolve(body) })
            }),
        )
    }

    /** A stand-in for `context.auth`: records the sign-in a callback performs. */
    const fakeAuth = (presented?: { userId: bigint; token: string }) => {
        const state = { login: undefined as { userId: string; token: string } | undefined }
        return {
            state,
            auth: {
                getUserId: () => (presented === undefined ? null : String(presented.userId)),
                getPresentedUserToken: () => presented?.token,
                check: () => presented !== undefined,
                login: (userId: string | undefined, token: string | undefined) => {
                    if (userId === undefined || token === undefined) return Promise.resolve(false)
                    state.login = { userId, token }
                    return Promise.resolve(true)
                },
                logout: () => Promise.resolve(true),
                logoutAll: () => Promise.resolve(0),
            },
        }
    }

    const callback = (
        providerName: string,
        auth: ReturnType<typeof fakeAuth>['auth'],
        sessionId: string | null = 'browser-session',
    ) => oauthService.handleCallback(providerName, 'code', 'st', 'st', 'cv', auth, sessionId)

    const mailedToken = (to: string): string => {
        const message = [...mail.sent].reverse().find((m) => m.to === to)
        const match = message?.text.match(/token=([\w-]+)/)
        if (match?.[1] === undefined) throw new Error(`no link mailed to ${to}`)
        return decodeURIComponent(match[1])
    }

    beforeEach(() => {
        mail.sent.length = 0
        destroyed.tokens.length = 0
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id))
        await sessionCheckPool.end()
        await pool.end()
    })

    describe('authoritative Google claims an unverified account (paths B, C, D)', () => {
        it('takes away the password, phone, other links, devices and pending tokens', async () => {
            const email = address('claim')
            const attacker = await insertUser({ email, phone: `+1555${String(now).slice(-7)}` })
            await oauthAccountRepository.create({
                userId: attacker.id,
                provider: 'facebook',
                providerUserId: `fb-${String(now)}`,
                providerEmail: email,
            })
            await db.insert(pushSubscriptions).values({
                userId: attacker.id,
                endpoint: `https://push.test/${String(now)}`,
                p256dhKey: 'key',
                authKey: 'auth',
            })
            // Path D: a pending change of address to the attacker's mailbox.
            const [pendingLink] = await db
                .insert(emailLinkVerifications)
                .values({
                    userId: attacker.id,
                    targetEmail: `attacker-${String(now)}@evil.test`,
                    tokenHash: sha256(`d-${String(now)}`),
                    expiresAt: new Date(Date.now() + 60_000),
                })
                .returning()
            provider({ id: `g-claim-${String(now)}`, email })
            const { auth, state } = fakeAuth()

            const result = await callback('google', auth)

            expect(Result.isOk(result) && result.value.redirectUrl).toBe('/?oauth=success')
            const row = await userRow(attacker.id)
            expect(row?.emailVerifiedAt).not.toBeNull()
            expect(row?.password).toBeNull()
            expect(row?.phone).toBeNull()
            expect(row?.sessionToken).not.toBe(attacker.sessionToken)
            const links = await linksOf(attacker.id)
            expect(links.map((link) => link.provider)).toEqual(['google'])
            expect(
                await db
                    .select()
                    .from(pushSubscriptions)
                    .where(eq(pushSubscriptions.userId, attacker.id)),
            ).toHaveLength(0)
            const [link] = await db
                .select()
                .from(emailLinkVerifications)
                .where(eq(emailLinkVerifications.id, pendingLink?.id ?? 0n))
            expect(link?.usedAt).not.toBeNull()
            expect(destroyed.tokens).toContain(attacker.sessionToken)
            expect(state.login).toEqual({ userId: String(attacker.id), token: row?.sessionToken })
        })

        it('links a verified account without taking anything away', async () => {
            const email = address('verified')
            const owner = await insertUser({ email, verified: true })
            provider({ id: `g-verified-${String(now)}`, email })
            const { auth, state } = fakeAuth()

            const result = await callback('google', auth)

            expect(Result.isOk(result)).toBe(true)
            const row = await userRow(owner.id)
            expect(row?.password).toBe(owner.password)
            expect(row?.sessionToken).toBe(owner.sessionToken)
            expect(state.login?.token).toBe(owner.sessionToken)
        })
    })

    describe('a Google address Google does not host (path G)', () => {
        it('mails a link instead of linking, and signs nobody in', async () => {
            const email = address('custom', 'company.test')
            const attacker = await insertUser({ email })
            provider({ id: `g-custom-${String(now)}`, email })
            const { auth, state } = fakeAuth()

            const result = await callback('google', auth)

            expect(Result.isOk(result) && result.value.redirectUrl).toBe('/?oauth=link_pending')
            expect(state.login).toBeUndefined()
            expect(await linksOf(attacker.id)).toHaveLength(0)
            expect((await userRow(attacker.id))?.password).toBe(attacker.password)
            expect(mail.sent.map((m) => m.to)).toEqual([email])
        })
    })

    describe('a provider that does not prove the address (path A)', () => {
        it('creates the account without users.email and mails the address', async () => {
            const email = address('facebook-new')
            provider({ id: `fb-new-${String(now)}`, email })
            const { auth, state } = fakeAuth()

            const result = await callback('facebook', auth)

            expect(Result.isOk(result)).toBe(true)
            const userId = BigInt(state.login?.userId ?? '0')
            createdUserIds.push(userId)
            expect((await userRow(userId))?.email).toBeNull()
            const [link] = await linksOf(userId)
            expect(link?.providerEmail).toBe(email)
            expect(mail.sent.map((m) => m.to)).toEqual([email])
        })

        it('confirms the link only in the browser that started it, then claims', async () => {
            const email = address('mailed-link')
            const attacker = await insertUser({ email })
            const facebookId = `fb-link-${String(now)}`
            provider({ id: facebookId, email })
            const started = await callback('facebook', fakeAuth().auth, 'owner-browser')
            expect(Result.isOk(started)).toBe(true)
            const token = mailedToken(email)

            // Another browser (the attacker's, or a click in a mail app) does nothing.
            const elsewhere = await oauthService.confirmLink(token, fakeAuth().auth, 'other')
            expect(Result.isError(elsewhere) && elsewhere.error).toMatchObject({
                reason: 'oauth_link_wrong_session',
            })
            const [pending] = await db
                .select()
                .from(oauthLinkVerifications)
                .where(eq(oauthLinkVerifications.tokenHash, sha256(token)))
            expect(pending?.usedAt).toBeNull()

            const { auth, state } = fakeAuth()
            const confirmed = await oauthService.confirmLink(token, auth, 'owner-browser')

            expect(Result.isOk(confirmed)).toBe(true)
            const row = await userRow(attacker.id)
            expect(row?.emailVerifiedAt).not.toBeNull()
            expect(row?.password).toBeNull()
            expect((await linksOf(attacker.id)).map((link) => link.providerUserId)).toEqual([
                facebookId,
            ])
            expect(state.login?.token).toBe(row?.sessionToken)
        })

        it('refuses a link whose account changed its address meanwhile', async () => {
            const email = address('changed')
            const owner = await insertUser({ email, verified: true })
            provider({ id: `fb-changed-${String(now)}`, email })
            await callback('facebook', fakeAuth().auth, 'owner-browser')
            const token = mailedToken(email)
            await db
                .update(users)
                .set({ email: address('moved') })
                .where(eq(users.id, owner.id))

            const result = await oauthService.confirmLink(token, fakeAuth().auth, 'owner-browser')

            expect(Result.isError(result) && result.error).toMatchObject({
                reason: 'email_changed',
            })
            expect(await linksOf(owner.id)).toHaveLength(0)
        })
    })

    describe('mailed links clicked by somebody who did not ask (paths E, F)', () => {
        it('does not confirm a registration without the account password', async () => {
            const email = address('registration')
            const attacker = await insertUser({ email })
            const raw = `reg-${String(now)}`
            await emailVerificationRepository.create({
                userId: attacker.id,
                tokenHash: sha256(raw),
                expiresAt: new Date(Date.now() + 60_000),
            })
            const victim = { userId: null, presentedSessionToken: undefined }

            const clicked = await emailVerificationService.verifyEmail(
                raw,
                { ipAddress: '127.0.0.1' },
                victim,
            )

            expect(Result.isError(clicked) && clicked.error).toMatchObject({
                reason: 'password_required',
            })
            expect((await userRow(attacker.id))?.emailVerifiedAt).toBeNull()
            const [token] = await db
                .select()
                .from(emailVerifications)
                .where(eq(emailVerifications.tokenHash, sha256(raw)))
            expect(token?.usedAt).toBeNull()
        })

        it('does not add an address to an account the clicking browser is not signed in to', async () => {
            const attacker = await insertUser({ email: null })
            const raw = `link-${String(now)}`
            await emailLinkVerificationRepository.create({
                userId: attacker.id,
                targetEmail: address('first'),
                tokenHash: sha256(raw),
                expiresAt: new Date(Date.now() + 60_000),
            })

            const clicked = await emailVerificationService.verifyEmail(
                raw,
                { ipAddress: '127.0.0.1' },
                { userId: null, presentedSessionToken: undefined },
            )

            expect(Result.isError(clicked) && clicked.error).toMatchObject({
                reason: 'email_link_wrong_session',
            })
            expect((await userRow(attacker.id))?.email).toBeNull()
        })
    })

    describe('a sign-in by an existing link racing a claim', () => {
        it('refuses the sign-in when the claim removed the link after it was read', async () => {
            const email = address('race')
            const attacker = await insertUser({ email })
            const facebookId = `fb-race-${String(now)}`
            await oauthAccountRepository.create({
                userId: attacker.id,
                provider: 'facebook',
                providerUserId: facebookId,
                providerEmail: email,
            })
            // The attacker's callback reads the link; the owner's claim commits before it goes on.
            const realFind =
                oauthAccountRepository.findByProviderAndProviderId.bind(oauthAccountRepository)
            vi.spyOn(oauthAccountRepository, 'findByProviderAndProviderId').mockImplementationOnce(
                async (...args) => {
                    const row = await realFind(...args)
                    provider({ id: `g-race-${String(now)}`, email })
                    const claimed = await callback('google', fakeAuth().auth)
                    expect(Result.isOk(claimed)).toBe(true)
                    provider({ id: facebookId, email })
                    return row
                },
            )
            provider({ id: facebookId, email })
            const { auth, state } = fakeAuth()

            const result = await callback('facebook', auth)

            expect(Result.isError(result) && result.error).toMatchObject({
                reason: 'oauth_link_revoked',
            })
            expect(state.login).toBeUndefined()
        })
    })

    describe('a password reset by mail (the owner without Google)', () => {
        it('claims the unverified account', async () => {
            const email = address('reset')
            const attacker = await insertUser({ email, phone: `+1666${String(now).slice(-7)}` })
            await oauthAccountRepository.create({
                userId: attacker.id,
                provider: 'facebook',
                providerUserId: `fb-reset-${String(now)}`,
                providerEmail: email,
            })
            const sent = await passwordResetService.sendPasswordResetEmail(attacker.id)
            expect(Result.isOk(sent)).toBe(true)
            const token = mailedToken(email)

            const result = await passwordResetService.resetPassword(
                token,
                'owner-secret-1',
                'owner-secret-1',
                { ipAddress: '127.0.0.1' },
            )

            expect(Result.isOk(result)).toBe(true)
            const row = await userRow(attacker.id)
            expect(row?.emailVerifiedAt).not.toBeNull()
            expect(row?.phone).toBeNull()
            expect(await linksOf(attacker.id)).toHaveLength(0)
            const pending = await db
                .select()
                .from(oauthLinkVerifications)
                .where(
                    and(
                        eq(oauthLinkVerifications.userId, attacker.id),
                        isNull(oauthLinkVerifications.usedAt),
                    ),
                )
            expect(pending).toHaveLength(0)
        })
    })
})
