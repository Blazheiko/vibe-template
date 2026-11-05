import { createHash } from 'node:crypto'

import { Result } from 'better-result'
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { appErrorMessage } from '../shared/errors.js'

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
const mail = vi.hoisted(() => ({ sent: [] as { to: string; text: string; html: string }[] }))
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
        return Promise.resolve({ deleted: 0, complete: true })
    },
}))
vi.mock('#app/services/notifications/email-service.js', async () => {
    const { Result: R } = await import('better-result')
    return {
        emailService: {
            send: (message: { to: string; text: string; html: string }) => {
                mail.sent.push({ to: message.to, text: message.text, html: message.html })
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
    const { pushSubscriptionService } =
        await import('#app/services/notifications/push-subscription-service.js')
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
        name?: string
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
                    : {
                          id: profile.id,
                          email: profile.email,
                          name: profile.name ?? 'Facebook Person',
                      }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
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
                logoutAll: () => Promise.resolve({ deleted: 0, complete: true }),
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
                endpoint: `https://fcm.googleapis.com/fcm/send/${String(now)}`,
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
    // feat-098: what a request admitted before a claim may still write after it.
    describe('a push subscription from a session a claim revoked', () => {
        const subscription = (label: string) => ({
            endpoint: `https://fcm.googleapis.com/fcm/send/${label}-${String(now)}-${String(counter)}`,
            p256dhKey: 'attacker-key',
            authKey: 'attacker-auth',
            notificationTypes: ['system'],
        })
        const devicesOf = async (userId: bigint) =>
            db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId))

        it('is refused after the claim, and nothing is inserted', async () => {
            const email = address('push')
            const attacker = await insertUser({ email })
            // The attacker's request was authenticated with this token; the owner then claims.
            provider({ id: `g-push-${String(now)}`, email })
            const claimed = await callback('google', fakeAuth().auth)
            expect(Result.isOk(claimed)).toBe(true)

            const result = await pushSubscriptionService.createSubscription(
                attacker.id,
                subscription('after-claim') as never,
                attacker.sessionToken,
            )

            expect(Result.isError(result) && result.error).toMatchObject({
                reason: 'session_revoked',
            })
            expect(await devicesOf(attacker.id)).toHaveLength(0)
        })

        it('waits for a claim holding the user lock, then is refused', async () => {
            const attacker = await insertUser({ email: address('push-lock') })
            const client = await pool.connect()
            try {
                await client.query('BEGIN')
                await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
                    attacker.id.toString(),
                ])
                let settled = false
                const pending = pushSubscriptionService
                    .createSubscription(
                        attacker.id,
                        subscription('during-claim') as never,
                        attacker.sessionToken,
                    )
                    .finally(() => {
                        settled = true
                    })
                await new Promise((resolve) => setTimeout(resolve, 200))
                expect(settled).toBe(false)
                // What a claim does under the lock: rotate the token, remove the devices.
                await client.query('UPDATE users SET session_token = $1 WHERE id = $2', [
                    `rotated-${String(now)}`,
                    attacker.id.toString(),
                ])
                await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [
                    attacker.id.toString(),
                ])
                await client.query('COMMIT')

                const result = await pending
                expect(Result.isError(result) && result.error).toMatchObject({
                    reason: 'session_revoked',
                })
            } finally {
                client.release()
            }
            expect(await devicesOf(attacker.id)).toHaveLength(0)
        })

        it('is written while the session is current (control)', async () => {
            const owner = await insertUser({ email: address('push-ok'), verified: true })

            const result = await pushSubscriptionService.createSubscription(
                owner.id,
                subscription('current') as never,
                owner.sessionToken,
            )

            expect(Result.isOk(result)).toBe(true)
            expect(await devicesOf(owner.id)).toHaveLength(1)
        })
    })

    describe('concurrent callbacks of one new identity (feat-098)', () => {
        it('leave one user and one link; both browsers are signed in to it', async () => {
            const email = address('twice', 'example.com')
            const facebookId = `fb-twice-${String(now)}`
            const name = `Twice ${String(now)}`
            provider({ id: facebookId, email, name })
            // Both callbacks pass the link lookup before either creates anything.
            const realFind =
                oauthAccountRepository.findByProviderAndProviderId.bind(oauthAccountRepository)
            let arrived = 0
            let release: () => void = () => undefined
            const bothArrived = new Promise<void>((resolve) => {
                release = resolve
            })
            vi.spyOn(oauthAccountRepository, 'findByProviderAndProviderId').mockImplementation(
                async (...args) => {
                    const row = await realFind(...args)
                    arrived += 1
                    if (arrived === 2) release()
                    if (arrived <= 2) await bothArrived
                    return row
                },
            )
            const first = fakeAuth()
            const second = fakeAuth()

            const results = await Promise.all([
                callback('facebook', first.auth, 'browser-one'),
                callback('facebook', second.auth, 'browser-two'),
            ])

            expect(results.map((result) => Result.isOk(result))).toEqual([true, true])
            const created = await db.select().from(users).where(eq(users.name, name))
            for (const row of created) createdUserIds.push(row.id)
            expect(created).toHaveLength(1)
            const links = await db
                .select()
                .from(oauthAccounts)
                .where(eq(oauthAccounts.providerUserId, facebookId))
            expect(links).toHaveLength(1)
            expect(links[0]?.userId).toBe(created[0]?.id)
            expect(first.state.login?.userId).toBe(String(created[0]?.id))
            expect(second.state.login?.userId).toBe(String(created[0]?.id))
        })
    })

    // feat-108 (R05): what the provider says is data, never markup or an account key.
    describe('provider answers that are not a profile (feat-108)', () => {
        const oauthRowsFor = async (providerUserId: string) =>
            db.select().from(oauthAccounts).where(eq(oauthAccounts.providerUserId, providerUserId))

        // feat-126: the error body reads like a full profile, id included, so only the status
        // check stops it (before, an empty id stopped it and the test passed without that check).
        it('a provider error answer signs nobody in and stores nothing', async () => {
            const email = address('provider-error')
            vi.stubGlobal(
                'fetch',
                vi.fn(() =>
                    Promise.resolve({
                        ok: false,
                        status: 500,
                        json: () =>
                            Promise.resolve({
                                id: 'fb-error-profile',
                                name: 'Error Body',
                                email,
                                error: 'internal',
                            }),
                    }),
                ),
            )
            const { auth, state } = fakeAuth()

            const result = await callback('facebook', auth)

            expect(Result.isError(result) && appErrorMessage(result.error)).toBe(
                'Failed to exchange authorization code',
            )
            expect(state.login).toBeUndefined()
            expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0)
            expect(await oauthRowsFor('fb-error-profile')).toHaveLength(0)
        })

        it('two profiles without an id do not share one account', async () => {
            for (const tag of ['first', 'second']) {
                provider({ id: '', email: address(`no-id-${tag}`) })
                const { auth, state } = fakeAuth()

                const result = await callback('facebook', auth)

                expect(Result.isError(result) && appErrorMessage(result.error)).toBe(
                    'Could not retrieve account id from provider',
                )
                expect(state.login).toBeUndefined()
            }
            expect(await oauthRowsFor('')).toHaveLength(0)
        })

        it('mails the provider profile name as text, not markup', async () => {
            const email = address('markup', 'company.test')
            await insertUser({ email })
            const name = '"><a href="https://evil.example">Secure your account</a>'
            vi.stubGlobal(
                'fetch',
                vi.fn(() =>
                    Promise.resolve({
                        ok: true,
                        status: 200,
                        json: () =>
                            Promise.resolve({
                                id: `g-markup-${String(now)}`,
                                email,
                                name,
                                verified_email: true,
                            }),
                    }),
                ),
            )
            const { auth } = fakeAuth()

            const result = await callback('google', auth)

            expect(Result.isOk(result) && result.value.redirectUrl).toBe('/?oauth=link_pending')
            const sent = mail.sent.find((m) => m.to === email)
            expect(sent?.html).not.toContain('<a href="https://evil.example">')
            expect(sent?.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;')
        })
    })
})
