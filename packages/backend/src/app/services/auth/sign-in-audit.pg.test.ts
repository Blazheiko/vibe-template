import { createHash, randomUUID } from 'node:crypto'

import { Result } from 'better-result'
import { asc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionAuthState } from 'shared/mfa'
import { hasPg } from '../../../test-support/pg-test-db.js'
import { auditLogLines, testAdminActor, testRequest } from '../../../test-support/audit-actor.js'

// feat-235 (Р3, Р4, Р6, Р13) on a real PostgreSQL: every change of the ways into an account and
// every mass revocation of its sessions writes exactly its events, with the right kind of actor
// and proof, in the transaction of the change; a failed insert rolls the change back and leaves
// the one-time proof usable. Providers, mail, push and Redis are stubbed as in
// oauth-pre-hijack.pg.test.ts.

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
    destroyAllSessions: () => Promise.resolve({ deleted: 0, complete: true }),
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
const sessionStillStored = (): Promise<boolean> => Promise.resolve(true)
// feat-245 (rows 6 and 8 of Р3): the session proved the password through POST /auth/reauth.
const freshPassword = (): SessionAuthState => ({
    v: 1,
    amr: ['pwd'],
    aal: 1,
    authenticatedAt: new Date().toISOString(),
    verified: { pwd: new Date().toISOString() },
})
const PASSWORD = 'current-password-123'
const CODE = '123456'

describe.skipIf(!hasPg)('sign-in methods and sessions in the audit log', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const schema = await import('#database/schema.js')
    const { auditEvents, users, oauthAccounts, passwordResetTokens, smsAuthChallenges } = schema
    const { oauthLinkVerifications, emailLinkVerifications } = schema
    const { oauthAccountRepository, emailLinkVerificationRepository } =
        await import('#app/repositories/index.js')
    const { auditService } = await import('#app/services/audit/audit-service.js')
    const { authService } = await import('#app/services/auth/auth-service.js')
    const { sessionListService } = await import('#app/services/user/session-list-service.js')
    const { passwordResetService } = await import('#app/services/auth/password-reset-service.js')
    const { oauthService } = await import('#app/services/auth/oauth-service.js')
    const { emailVerificationService } =
        await import('#app/services/auth/email-verification-service.js')
    const { signInMethodsService } = await import('#app/services/auth/sign-in-methods-service.js')
    const { hashOtpVerificationCode } = await import('#app/services/auth/otp-verification-hash.js')
    const { authConfig: readonlyAuthConfig } = await import('#config/auth.js')
    const { hashPassword } = await import('metautil')
    const authConfig = readonlyAuthConfig as {
        -readonly [K in keyof typeof readonlyAuthConfig]: (typeof readonlyAuthConfig)[K]
    }
    const savedAuthConfig = {
        phoneAuthEnabled: authConfig.phoneAuthEnabled,
        otpHmacKey: authConfig.otpHmacKey,
    }

    const now = Date.now()
    const createdUserIds: bigint[] = []
    let counter = 0
    let passwordHash = ''

    const address = (label: string, domain = 'gmail.com'): string => {
        counter += 1
        return `audit-${label}-${String(counter)}-${String(now)}@${domain}`
    }
    const nextPhone = (): string => {
        counter += 1
        return `+1558${String(now % 100_000).padStart(5, '0')}${String(counter).padStart(2, '0')}`
    }

    const insertUser = async (options: {
        email?: string | null
        verified?: boolean
        phone?: string | null
        password?: boolean
    }) => {
        if (passwordHash === '') passwordHash = await hashPassword(PASSWORD)
        const [row] = await db
            .insert(users)
            .values({
                name: `audit-${String(counter)}`,
                email: options.email ?? null,
                emailVerifiedAt: options.verified === true ? new Date() : null,
                phone: options.phone ?? null,
                password: options.password === false ? null : passwordHash,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }
    const userRow = async (id: bigint) => {
        const [row] = await db.select().from(users).where(eq(users.id, id))
        if (row === undefined) throw new Error('user gone')
        return row
    }
    const eventsOf = (userId: bigint) =>
        db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.targetUserId, userId))
            .orderBy(asc(auditEvents.id))
    const linksOf = (userId: bigint) =>
        db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId))
    const failAudit = () =>
        vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit insert failed'))

    const insertResetLink = async (userId: bigint, targetEmail: string | null) => {
        const raw = `reset-${randomUUID()}`
        const [row] = await db
            .insert(passwordResetTokens)
            .values({
                userId,
                targetEmail,
                tokenHash: sha256(raw),
                expiresAt: new Date(Date.now() + 60 * 60_000),
            })
            .returning()
        if (row === undefined) throw new Error('reset link not inserted')
        return { raw, row }
    }
    const resetLinkUsedAt = async (id: bigint) => {
        const [row] = await db
            .select({ usedAt: passwordResetTokens.usedAt })
            .from(passwordResetTokens)
            .where(eq(passwordResetTokens.id, id))
        return row?.usedAt ?? null
    }

    const request = () => ({ requestId: randomUUID(), logger: { info: vi.fn() } })

    const provider = (profile: { id: string; email: string }): void => {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                const body = url.startsWith('https://www.googleapis.com/')
                    ? { id: profile.id, email: profile.email, name: 'G', verified_email: true }
                    : { id: profile.id, email: profile.email, name: 'Facebook Person' }
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
            }),
        )
    }
    const fakeAuth = () => ({
        getUserId: () => null,
        getPresentedUserToken: () => undefined,
        check: () => false,
        login: (userId: string | undefined, token: string | undefined) =>
            Promise.resolve(
                userId === undefined || token === undefined
                    ? null
                    : {
                          publicId: 'p'.repeat(22),
                          ip: '',
                          userAgent: '',
                          method: 'oauth' as const,
                          signedInAt: new Date().toISOString(),
                      },
            ),
        logout: () => Promise.resolve(true),
        logoutAll: () => Promise.resolve({ deleted: 0, complete: true }),
        // feat-245: a second-step sign-in is not exercised here.
        getCookieSessionId: () => undefined,
        getMfaTicketCookie: () => undefined,
        setMfaTicketCookie: () => undefined,
        planLogin: () => {
            throw new Error('not used')
        },
        prepareLogin: () => Promise.resolve('conflict' as const),
        activateLogin: () => Promise.resolve('gone' as const),
    })
    const mailedToken = (to: string): string => {
        const message = [...mail.sent].reverse().find((m) => m.to === to)
        const match = message?.text.match(/token=([\w-]+)/)
        if (match?.[1] === undefined) throw new Error(`no link mailed to ${to}`)
        return decodeURIComponent(match[1])
    }

    beforeEach(() => {
        mail.sent.length = 0
        authConfig.phoneAuthEnabled = true
        authConfig.otpHmacKey = 'sign-in-audit-otp-key-0123456789abcdef'
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        Object.assign(authConfig, savedAuthConfig)
        for (const id of createdUserIds) {
            await db.delete(auditEvents).where(eq(auditEvents.targetUserId, id))
            await db.delete(users).where(eq(users.id, id))
        }
        await sessionCheckPool.end()
        await pool.end()
    })

    // ─── mass revocation of sessions ─────────────────────────────────────────────────────────

    const logoutAll = (
        user: { id: bigint; sessionToken: string },
        actor = testAdminActor(user.id),
    ) =>
        authService.logoutAll(
            {
                getUserId: () => String(user.id),
                getPresentedUserToken: () => user.sessionToken,
                logoutAll: () => Promise.resolve({ deleted: 0, complete: true }),
                // feat-245: a second-step sign-in is not exercised here.
                getCookieSessionId: () => undefined,
                getMfaTicketCookie: () => undefined,
                setMfaTicketCookie: () => undefined,
                planLogin: () => {
                    throw new Error('not used')
                },
                prepareLogin: () => Promise.resolve('conflict' as const),
                activateLogin: () => Promise.resolve('gone' as const),
            } as never,
            { sessionInfo: { id: 's', data: { csrfToken: 'c'.repeat(43) } } } as never,
            actor,
        )

    describe('logout everywhere', () => {
        it('writes one auth.sessions.revoked_all by the user', async () => {
            const user = await insertUser({ email: address('logout-all'), verified: true })
            const actor = testAdminActor(user.id)

            expect((await logoutAll(user, actor)).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
                action: 'auth.sessions.revoked_all',
                actorKind: 'user',
                actorUserId: user.id,
                // The role of the locked row, not the one the actor was built with.
                actorRole: 'user',
                targetType: 'user',
                targetId: String(user.id),
                requestId: actor.requestId,
                changes: null,
                metadata: null,
            })
            expect(auditLogLines(actor.logger)).toHaveLength(1)
        })

        it('a failed insert keeps the previous token and the reset links', async () => {
            const email = address('logout-all-fail')
            const user = await insertUser({ email, verified: true })
            const link = await insertResetLink(user.id, email)
            const actor = testAdminActor(user.id)
            failAudit()

            await expect(logoutAll(user, actor)).rejects.toThrow('audit insert failed')

            expect((await userRow(user.id)).sessionToken).toBe(user.sessionToken)
            expect(await resetLinkUsedAt(link.row.id)).toBeNull()
            expect(await eventsOf(user.id)).toEqual([])
            expect(auditLogLines(actor.logger)).toEqual([])
        })

        it('a revoked session writes nothing', async () => {
            const user = await insertUser({ email: address('logout-all-stale'), verified: true })

            const result = await logoutAll({ ...user, sessionToken: 'stale' })

            expect(result.isErr()).toBe(true)
            expect(await eventsOf(user.id)).toEqual([])
        })
    })

    describe('end the other sessions', () => {
        const revokeOthers = (
            user: { id: bigint; sessionToken: string },
            actor = testAdminActor(),
        ) =>
            sessionListService.revokeOthers({
                userId: user.id,
                presentedSessionToken: user.sessionToken,
                requestingSessionId: 'sid',
                sessionStored: sessionStillStored,
                actor,
            })

        it('writes one auth.sessions.revoked_others by the user', async () => {
            const user = await insertUser({ email: address('others'), verified: true })
            const actor = testAdminActor(user.id)

            expect((await revokeOthers(user, actor)).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(
                events.map((event) => [event.action, event.actorKind, event.actorUserId]),
            ).toEqual([['auth.sessions.revoked_others', 'user', user.id]])
        })

        it('a failed insert keeps the previous token', async () => {
            const user = await insertUser({ email: address('others-fail'), verified: true })
            failAudit()

            await expect(revokeOthers(user)).rejects.toThrow('audit insert failed')

            expect((await userRow(user.id)).sessionToken).toBe(user.sessionToken)
            expect(await eventsOf(user.id)).toEqual([])
        })
    })

    describe('change password', () => {
        const change = (user: { id: bigint; sessionToken: string }, actor = testAdminActor()) =>
            authService.changePassword(
                user.id,
                { newPassword: 'another-password-456' },
                user.sessionToken,
                sessionStillStored,
                undefined,
                actor,
                freshPassword(),
            )

        it('writes one auth.password.changed', async () => {
            const user = await insertUser({ email: address('change'), verified: true })
            const actor = testAdminActor(user.id)

            expect((await change(user, actor)).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
                action: 'auth.password.changed',
                actorKind: 'user',
                actorUserId: user.id,
                // feat-245 (Р14): the proof that allowed the change.
                metadata: { sessionsRevoked: 'others', proof: 'password' },
            })
            expect(JSON.stringify(events[0]?.metadata)).not.toContain('another-password')
        })

        it('a failed insert keeps the old password and token', async () => {
            const user = await insertUser({ email: address('change-fail'), verified: true })
            failAudit()

            await expect(change(user)).rejects.toThrow('audit insert failed')

            const after = await userRow(user.id)
            expect(after.password).toBe(user.password)
            expect(after.sessionToken).toBe(user.sessionToken)
            expect(await eventsOf(user.id)).toEqual([])
        })
    })

    // ─── password reset ──────────────────────────────────────────────────────────────────────

    describe('password reset by a mailed link', () => {
        const reset = (raw: string, req = request()) =>
            passwordResetService.resetPassword(
                raw,
                'owner-secret-1',
                'owner-secret-1',
                { ipAddress: '127.0.0.1' },
                {
                    kind: 'proof_holder',
                    userId: null,
                    role: null,
                    requestId: req.requestId,
                    proof: 'email_link',
                    source: null,
                    logger: req.logger,
                },
            )

        it('a verified account: one auth.password.reset by the link holder, no claim', async () => {
            const email = address('reset-verified')
            const user = await insertUser({ email, verified: true })
            const { raw } = await insertResetLink(user.id, email)

            expect((await reset(raw)).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
                action: 'auth.password.reset',
                actorKind: 'proof_holder',
                actorUserId: null,
                actorRole: null,
                metadata: { proof: 'email_link', claimed: false },
            })
        })

        it('an unverified account: the reset and the claim with both providers, one stamp', async () => {
            const email = address('reset-claim')
            const user = await insertUser({ email, phone: nextPhone() })
            for (const name of ['github', 'facebook']) {
                await oauthAccountRepository.create({
                    userId: user.id,
                    provider: name,
                    providerUserId: `${name}-${String(now)}-${String(counter)}`,
                    providerEmail: email,
                })
            }
            const { raw } = await insertResetLink(user.id, email)
            const req = request()

            expect((await reset(raw, req)).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(events.map((event) => event.action)).toEqual([
                'auth.password.reset',
                'auth.account.claimed',
            ])
            const [resetEvent, claimed] = events
            expect(resetEvent?.metadata).toEqual({ proof: 'email_link', claimed: true })
            expect(claimed).toMatchObject({
                actorKind: 'proof_holder',
                actorUserId: null,
                metadata: {
                    proof: 'email_link',
                    passwordCleared: true,
                    phoneRemoved: true,
                    oauthRemoved: ['facebook', 'github'],
                    pushSubscriptionsRemoved: 0,
                    mfaRemoved: false,
                },
            })
            expect(resetEvent?.requestId).toBe(req.requestId)
            expect(claimed?.requestId).toBe(req.requestId)
            expect(claimed?.occurredAt).toEqual(resetEvent?.occurredAt)
            expect(auditLogLines(req.logger)).toHaveLength(2)
            // No address or phone in the log.
            expect(JSON.stringify(events.map((event) => event.metadata))).not.toContain('@')
        })

        it('a failed insert keeps the link usable and the password as it was', async () => {
            const email = address('reset-fail')
            const user = await insertUser({ email, verified: true })
            const link = await insertResetLink(user.id, email)
            failAudit()

            await expect(reset(link.raw)).rejects.toThrow('audit insert failed')

            expect(await resetLinkUsedAt(link.row.id)).toBeNull()
            expect((await userRow(user.id)).password).toBe(user.password)
            expect(await eventsOf(user.id)).toEqual([])
        })
    })

    describe('password reset by an SMS code', () => {
        const arrange = async () => {
            const phone = nextPhone()
            const user = await insertUser({ phone })
            const [challenge] = await db
                .insert(smsAuthChallenges)
                .values({
                    flow: 'reset_phone',
                    phone,
                    metadata: { userId: String(user.id) },
                    codeHash: hashOtpVerificationCode(CODE),
                    resendAvailableAt: new Date(),
                    expiresAt: new Date(Date.now() + 10 * 60_000),
                })
                .returning()
            if (challenge === undefined) throw new Error('challenge not inserted')
            return { user, challenge }
        }
        const complete = (challengeId: string) =>
            passwordResetService.completePhonePasswordReset(
                challengeId,
                CODE,
                'new-password-123',
                'new-password-123',
                { ipAddress: '203.0.113.1' },
                {
                    kind: 'proof_holder',
                    userId: null,
                    role: null,
                    requestId: randomUUID(),
                    proof: 'sms_code',
                    source: null,
                    logger: { info: vi.fn() },
                },
            )

        it('writes one auth.password.reset with the SMS code as proof', async () => {
            const { user, challenge } = await arrange()

            expect((await complete(challenge.id)).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
                action: 'auth.password.reset',
                actorKind: 'proof_holder',
                actorUserId: null,
                metadata: { proof: 'sms_code', claimed: false },
            })
        })

        it('a failed insert leaves the challenge unconfirmed and the password as it was', async () => {
            const { user, challenge } = await arrange()
            failAudit()

            await expect(complete(challenge.id)).rejects.toThrow('audit insert failed')

            const [row] = await db
                .select({ confirmedAt: smsAuthChallenges.confirmedAt })
                .from(smsAuthChallenges)
                .where(eq(smsAuthChallenges.id, challenge.id))
            expect(row?.confirmedAt).toBeNull()
            expect((await userRow(user.id)).password).toBe(user.password)
            expect(await eventsOf(user.id)).toEqual([])
        })
    })

    // ─── OAuth links ─────────────────────────────────────────────────────────────────────────

    describe('an OAuth link proved by the provider (linkTrusted)', () => {
        const callback = (req = request()) =>
            oauthService.handleCallback(
                'google',
                'code',
                'st',
                'st',
                'cv',
                fakeAuth(),
                'browser',
                req,
            )

        it('a verified account: one auth.oauth.linked by a proof holder', async () => {
            const email = address('trusted')
            const user = await insertUser({ email, verified: true })
            provider({ id: `g-trusted-${String(now)}-${String(counter)}`, email })
            const req = request()

            expect((await callback(req)).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
                action: 'auth.oauth.linked',
                actorKind: 'proof_holder',
                actorUserId: null,
                requestId: req.requestId,
                metadata: { method: 'oauth', provider: 'google', proof: 'oauth_provider_email' },
            })
        })

        it('an unverified account: the link and the claim', async () => {
            const email = address('trusted-claim')
            const user = await insertUser({ email })
            provider({ id: `g-claim-${String(now)}-${String(counter)}`, email })

            expect((await callback()).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(events.map((event) => event.action)).toEqual([
                'auth.oauth.linked',
                'auth.account.claimed',
            ])
            expect(events[1]?.metadata).toMatchObject({
                proof: 'oauth_provider_email',
                passwordCleared: true,
            })
        })

        it('a failed insert links nothing and claims nothing', async () => {
            const email = address('trusted-fail')
            const user = await insertUser({ email })
            provider({ id: `g-fail-${String(now)}-${String(counter)}`, email })
            failAudit()

            await expect(callback()).rejects.toThrow('audit insert failed')

            expect(await linksOf(user.id)).toEqual([])
            const after = await userRow(user.id)
            expect(after.emailVerifiedAt).toBeNull()
            expect(after.password).toBe(user.password)
            expect(await eventsOf(user.id)).toEqual([])
        })
    })

    describe('an OAuth link confirmed by mail (confirmLink)', () => {
        const startLink = async (email: string) => {
            provider({ id: `fb-${String(now)}-${String(counter)}`, email })
            const started = await oauthService.handleCallback(
                'facebook',
                'code',
                'st',
                'st',
                'cv',
                fakeAuth(),
                'owner-browser',
                testRequest(),
            )
            expect(Result.isOk(started)).toBe(true)
            return mailedToken(email)
        }

        it('writes auth.oauth.linked by the link holder, and the claim of an unverified account', async () => {
            const email = address('mailed')
            const user = await insertUser({ email })
            const token = await startLink(email)
            const req = request()

            const confirmed = await oauthService.confirmLink(
                token,
                fakeAuth(),
                'owner-browser',
                req,
            )

            expect(confirmed.isOk()).toBe(true)
            const events = await eventsOf(user.id)
            expect(events.map((event) => event.action)).toEqual([
                'auth.oauth.linked',
                'auth.account.claimed',
            ])
            expect(events[0]).toMatchObject({
                actorKind: 'proof_holder',
                actorUserId: null,
                requestId: req.requestId,
                metadata: { method: 'oauth', provider: 'facebook', proof: 'oauth_email_link' },
            })
        })

        it('a failed insert keeps the mailed link usable', async () => {
            const email = address('mailed-fail')
            const user = await insertUser({ email, verified: true })
            const token = await startLink(email)
            failAudit()

            await expect(
                oauthService.confirmLink(token, fakeAuth() as never, 'owner-browser', request()),
            ).rejects.toThrow('audit insert failed')

            const [pending] = await db
                .select({ usedAt: oauthLinkVerifications.usedAt })
                .from(oauthLinkVerifications)
                .where(eq(oauthLinkVerifications.tokenHash, sha256(token)))
            expect(pending?.usedAt).toBeNull()
            expect(await linksOf(user.id)).toEqual([])
            expect(await eventsOf(user.id)).toEqual([])
        })
    })

    // ─── e-mail link and unlink ──────────────────────────────────────────────────────────────

    describe('an e-mail address linked from a session of the account', () => {
        const arrange = async () => {
            const user = await insertUser({ email: null, phone: nextPhone() })
            const raw = `link-${randomUUID()}`
            await emailLinkVerificationRepository.create({
                userId: user.id,
                targetEmail: address('linked'),
                tokenHash: sha256(raw),
                expiresAt: new Date(Date.now() + 60_000),
            })
            return { user, raw }
        }
        const open = (user: { id: bigint; sessionToken: string }, raw: string, req = request()) =>
            emailVerificationService.verifyEmail(
                raw,
                { ipAddress: '127.0.0.1' },
                { userId: user.id, presentedSessionToken: user.sessionToken },
                req,
            )

        it('writes one auth.email.linked by the owner of the session, with the link as proof', async () => {
            const { user, raw } = await arrange()
            const req = request()

            expect((await open(user, raw, req)).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
                action: 'auth.email.linked',
                actorKind: 'user',
                actorUserId: user.id,
                requestId: req.requestId,
                metadata: { method: 'email', proof: 'email_link' },
            })
            expect(auditLogLines(req.logger)).toHaveLength(1)
        })

        it('a failed insert keeps the link usable and the account without an address', async () => {
            const { user, raw } = await arrange()
            failAudit()

            await expect(open(user, raw)).rejects.toThrow('audit insert failed')

            expect((await userRow(user.id)).email).toBeNull()
            const [pending] = await db
                .select({ usedAt: emailLinkVerifications.usedAt })
                .from(emailLinkVerifications)
                .where(eq(emailLinkVerifications.tokenHash, sha256(raw)))
            expect(pending?.usedAt).toBeNull()
            expect(await eventsOf(user.id)).toEqual([])
        })
    })

    describe('removing a sign-in method', () => {
        const arrange = async () => {
            const email = address('unlink')
            const user = await insertUser({ email, verified: true })
            const link = await oauthAccountRepository.create({
                userId: user.id,
                provider: 'github',
                providerUserId: `gh-${String(now)}-${String(counter)}`,
                providerEmail: email,
            })
            return { user, link }
        }
        const unlink = (
            user: { id: bigint; sessionToken: string },
            linkId: bigint,
            actor = testAdminActor(user.id),
        ) =>
            signInMethodsService.unlink(user.id, {
                linkId,
                presentedSessionToken: user.sessionToken,
                sessionAuth: freshPassword(),
                sessionStored: sessionStillStored,
                actor,
            })

        it('writes one auth.sign_in_method.unlinked by the user', async () => {
            const { user, link } = await arrange()

            expect((await unlink(user, link.id)).isOk()).toBe(true)

            const events = await eventsOf(user.id)
            expect(events).toHaveLength(1)
            expect(events[0]).toMatchObject({
                action: 'auth.sign_in_method.unlinked',
                actorKind: 'user',
                actorUserId: user.id,
                metadata: { method: 'oauth', provider: 'github', proof: 'password' },
            })
        })

        it('a failed insert keeps the link', async () => {
            const { user, link } = await arrange()
            failAudit()

            await expect(unlink(user, link.id)).rejects.toThrow('audit insert failed')

            expect((await linksOf(user.id)).map((row) => row.id)).toEqual([link.id])
            expect(await eventsOf(user.id)).toEqual([])
        })
    })
})
