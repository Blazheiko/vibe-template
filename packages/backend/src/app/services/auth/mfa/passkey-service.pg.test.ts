import { eq } from 'drizzle-orm'
import type { SessionToken } from '#app/domain/secrets.js'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import { testUserActor } from '../../../../test-support/audit-actor.js'
import { SoftAuthenticator } from '../../../../test-support/soft-authenticator.js'
import type { Session, SessionData, SessionInfo } from '#vendor/types/types.js'
import type { PasskeyId, UserId } from '#app/domain/ids.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6, Р12, tasks P2) against a real PostgreSQL and real
// WebAuthn answers (a software authenticator): the registration is idempotent by its enrollment
// id, a finished enrollment refuses another key, a first passkey needs a recovery contact and
// issues the codes, a recovery session records the new key as its replacement (R+), and the last
// way to sign in stays even under two concurrent removals.

vi.hoisted(() => {
    process.env['AUTH_OTP_HMAC_KEY'] ??= 'o'.repeat(32)
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
const security = vi.hoisted(() => vi.fn())
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security, supportReply: vi.fn() },
}))
vi.mock('#app/services/notifications/email-service.js', () => ({
    emailService: { send: () => Promise.resolve({ status: 'ok', value: { id: 'm' } }) },
}))

describe.skipIf(!hasPg)('passkey service on PostgreSQL (feat-246 P2)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, webauthnCredentials, auditEvents, mfaRecoveryCodes } =
        await import('#database/schema.js')
    const { default: webauthnConfig } = await import('#config/webauthn.js')
    const { passkeyService, PASSKEY_REGISTRATION_KEYS } = await import('./passkey-service.js')
    const { mergeSessionAuth, sessionAuthOf } = await import('shared/mfa')

    const RP = webauthnConfig.rpId
    const ORIGIN = webauthnConfig.origins[0] ?? ''

    const created: UserId[] = []
    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })
    beforeEach(() => {
        security.mockClear()
    })

    const NOW = Date.now()
    const iso = (offsetSeconds = 0): string => new Date(NOW + offsetSeconds * 1000).toISOString()

    interface TestUser {
        id: UserId
        sessionToken: SessionToken
    }
    const newUser = async (
        fields: { verified?: boolean; password?: string | null } = {},
    ): Promise<TestUser> => {
        const [user] = await db
            .insert(users)
            .values({
                name: 'passkey',
                email: `${crypto.randomUUID()}@example.test`,
                emailVerifiedAt: fields.verified === false ? null : new Date(),
                password: fields.password === undefined ? 'hash' : fields.password,
            })
            .returning({ id: users.id, sessionToken: users.sessionToken })
        if (user === undefined) throw new Error('user not inserted')
        created.push(user.id)
        return user
    }

    const fakeSession = (data: SessionData): Session & { failNextAuthWrite: () => void } => {
        let failNext = false
        const session = {
            sessionInfo: { id: `s-${crypto.randomUUID()}`, data, createdAt: iso() } as SessionInfo,
            failNextAuthWrite: () => {
                failNext = true
            },
            updateSessionData: (newData: SessionData) => {
                session.sessionInfo = {
                    ...session.sessionInfo,
                    data: { ...session.sessionInfo.data, ...newData },
                }
                return Promise.resolve(session.sessionInfo)
            },
            changeSessionData: () => Promise.resolve(null),
            consumeSessionData: () => Promise.resolve('gone' as const),
            isStored: () => Promise.resolve(true),
            destroySession: () => Promise.resolve(),
            updateSessionAuth: (
                apply: Parameters<Session['updateSessionAuth']>[0],
                options?: { removeKeys?: readonly string[] },
            ) => {
                if (failNext) {
                    failNext = false
                    return Promise.reject(new Error('Redis down'))
                }
                const current = sessionAuthOf(session.sessionInfo.data.auth)
                const kept = Object.fromEntries(
                    Object.entries(session.sessionInfo.data).filter(
                        ([key]) => !(options?.removeKeys ?? []).includes(key),
                    ),
                )
                session.sessionInfo = {
                    ...session.sessionInfo,
                    data: { ...kept, auth: mergeSessionAuth(current, apply(current)) },
                }
                return Promise.resolve(session.sessionInfo)
            },
        }
        return session
    }

    const freshPassword = (): SessionData => ({
        auth: {
            v: 1,
            amr: ['pwd'],
            aal: 1,
            authenticatedAt: iso(-60),
            verified: { pwd: iso(-10) },
        },
    })
    const freshPasskey = (): SessionData => ({
        auth: {
            v: 1,
            amr: ['webauthn'],
            aal: 2,
            authenticatedAt: iso(-60),
            verified: { webauthn: iso(-10) },
        },
    })

    const request = (user: TestUser, session: Session) => ({
        userId: user.id,
        session,
        presentedSessionToken: user.sessionToken,
        actor: testUserActor(user.id),
        now: NOW,
    })

    /** The options, then the authenticator's answer to them. */
    async function optionsAndAnswer(
        user: TestUser,
        session: Session,
        authenticator = new SoftAuthenticator(),
    ) {
        const options = await passkeyService.registerOptions(request(user, session))
        if (options.status !== 'ok') throw new Error(`options: ${JSON.stringify(options.error)}`)
        const opts = options.value.options as { challenge: string; user: { id: string } }
        const response = authenticator.register({
            challenge: opts.challenge,
            rpId: RP,
            origin: ORIGIN,
            userHandle: opts.user.id,
        })
        return { enrollmentId: options.value.enrollmentId, response, authenticator }
    }

    /** Keys stored directly, for the tests about removal. */
    async function storeKeys(userId: UserId, names: string[]): Promise<PasskeyId[]> {
        const { webauthnCredentialRepository, withTransaction } =
            await import('#app/repositories/index.js')
        return withTransaction(async (tx) => {
            const ids: PasskeyId[] = []
            for (const name of names) {
                const row = await webauthnCredentialRepository.insert(
                    {
                        userId,
                        credentialId: Buffer.from(crypto.randomUUID()),
                        publicKey: Buffer.from([1]),
                        signCount: 0n,
                        transports: null,
                        aaguid: null,
                        deviceType: 'multiDevice',
                        backedUp: true,
                        name,
                        enrollmentId: crypto.randomUUID().replaceAll('-', ''),
                    },
                    tx,
                )
                ids.push(row.id)
            }
            return ids
        })
    }

    const keysOf = (userId: UserId) =>
        db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId))
    const eventsOf = async (userId: UserId, action: string) =>
        (await db.select().from(auditEvents).where(eq(auditEvents.targetUserId, userId))).filter(
            (event) => event.action === action,
        )

    it('a first passkey: stored, codes issued once, audited, announced; the session is cleaned', async () => {
        const user = await newUser()
        const session = fakeSession(freshPassword())
        const { enrollmentId, response } = await optionsAndAnswer(user, session)
        const result = await passkeyService.register(request(user, session), {
            enrollmentId,
            name: 'Laptop',
            response,
        })
        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        expect(result.value.passkey.name).toBe('Laptop')
        expect(result.value.recoveryCodes).toHaveLength(10)
        expect(await keysOf(user.id)).toHaveLength(1)
        expect(await eventsOf(user.id, 'auth.passkey.added')).toHaveLength(1)
        expect(security).toHaveBeenCalledWith(user.id, 'passkey_added')
        for (const key of Object.values(PASSKEY_REGISTRATION_KEYS)) {
            expect(session.sessionInfo?.data[key]).toBeUndefined()
        }
    })

    // Р14: the registration records the proof the options accepted, kept with them in the
    // session, not one decided again from the marks and the factors of the registration.
    // feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 3): the proof the options kept is
    // checked again under the lock, against the account as it is when the key is written.
    it('a password set since the options: the kept recent sign-in no longer admits the key', async () => {
        const user = await newUser({ password: null })
        // No password: a recent social sign-in is the proof of the options.
        const session = fakeSession({
            auth: {
                v: 1,
                amr: ['oauth'],
                aal: 1,
                authenticatedAt: iso(-10),
                verified: { oauth: iso(-10) },
            },
        })
        const { enrollmentId, response } = await optionsAndAnswer(user, session)
        await db.update(users).set({ password: 'hash' }).where(eq(users.id, user.id))

        const result = await passkeyService.register(request(user, session), {
            enrollmentId,
            response,
        })
        expect(result.status === 'error' && result.error).toMatchObject({
            reason: 'reauth_required',
        })
        expect(await keysOf(user.id)).toHaveLength(0)
    })

    it('a passkey added in another session since password options: no second key by the password', async () => {
        const user = await newUser()
        const first = fakeSession(freshPassword())
        const pending = await optionsAndAnswer(user, first)
        const second = fakeSession(freshPassword())
        const other = await optionsAndAnswer(user, second)
        expect((await passkeyService.register(request(user, second), other)).status).toBe('ok')

        // With MFA on, only a factor proves the owner: the password options add nothing.
        const result = await passkeyService.register(request(user, first), pending)
        expect(result.status === 'error' && result.error).toMatchObject({
            reason: 'reauth_required',
        })
        expect(await keysOf(user.id)).toHaveLength(1)
    })

    it('options stored without their proof (before it was kept) start again, nothing stored', async () => {
        const user = await newUser()
        const session = fakeSession(freshPassword())
        const { enrollmentId, response } = await optionsAndAnswer(user, session)
        await session.updateSessionData({ [PASSKEY_REGISTRATION_KEYS.proof]: undefined })

        const result = await passkeyService.register(request(user, session), {
            enrollmentId,
            response,
        })
        expect(result.status === 'error' && result.error).toMatchObject({
            reason: 'enrollment_not_found',
        })
        expect(await keysOf(user.id)).toHaveLength(0)
    })

    it('a repeat after the commit (the session write failed) returns the same key; R+ in recovery', async () => {
        const user = await newUser()
        const session = fakeSession({
            auth: {
                v: 1,
                amr: ['pwd', 'recovery'],
                aal: 1,
                authenticatedAt: iso(-30),
                verified: { pwd: iso(-30) },
                recovery: { startedAt: iso(-30), expiresAt: iso(870) },
            },
        })
        const { enrollmentId, response } = await optionsAndAnswer(user, session)
        session.failNextAuthWrite()
        await expect(
            passkeyService.register(request(user, session), { enrollmentId, response }),
        ).rejects.toThrow('Redis down')
        expect(await keysOf(user.id)).toHaveLength(1)

        const again = await passkeyService.register(request(user, session), {
            enrollmentId,
            response,
        })
        expect(again.status).toBe('ok')
        const keys = await keysOf(user.id)
        expect(keys).toHaveLength(1)
        if (again.status === 'ok') expect(again.value.passkey.id).toBe(String(keys[0]?.id))
        expect(session.sessionInfo?.data.auth?.recovery?.replacementFactor).toMatchObject({
            kind: 'webauthn',
            id: String(keys[0]?.id),
        })
        expect(await eventsOf(user.id, 'auth.passkey.added')).toHaveLength(1)
    })

    it('parallel requests of one registration leave one key and one event', async () => {
        const user = await newUser()
        const session = fakeSession(freshPassword())
        const { enrollmentId, response } = await optionsAndAnswer(user, session)
        const results = await Promise.all([
            passkeyService.register(request(user, session), { enrollmentId, response }),
            passkeyService.register(request(user, session), { enrollmentId, response }),
        ])
        expect(results.map((result) => result.status)).toEqual(['ok', 'ok'])
        expect(await keysOf(user.id)).toHaveLength(1)
        expect(await eventsOf(user.id, 'auth.passkey.added')).toHaveLength(1)
    })

    it('a finished enrollment refuses another key; a spent challenge opens nothing', async () => {
        const user = await newUser()
        const session = fakeSession(freshPassword())
        const { enrollmentId, response } = await optionsAndAnswer(user, session)
        expect(
            (await passkeyService.register(request(user, session), { enrollmentId, response }))
                .status,
        ).toBe('ok')

        // The same enrollment, another authenticator's key.
        const other = new SoftAuthenticator().register({
            challenge: 'c3BlbnQ',
            rpId: RP,
            origin: ORIGIN,
            userHandle: 'aGFuZGxl',
        })
        const refused = await passkeyService.register(request(user, session), {
            enrollmentId,
            response: other,
        })
        expect(refused.status === 'error' && refused.error).toMatchObject({
            reason: 'enrollment_used',
        })

        // Another enrollment id: the challenge of this session was spent.
        const stale = await passkeyService.register(request(user, session), {
            enrollmentId: 'not-pending',
            response: other,
        })
        expect(stale.status === 'error' && stale.error).toMatchObject({
            reason: 'enrollment_not_found',
        })
        expect(await keysOf(user.id)).toHaveLength(1)
    })

    it('a first passkey needs a verified contact (Р12): 409 before and after the options', async () => {
        const user = await newUser({ verified: false })
        const session = fakeSession(freshPassword())
        const options = await passkeyService.registerOptions(request(user, session))
        expect(options.status === 'error' && options.error).toMatchObject({
            reason: 'recovery_contact_required',
        })
    })

    it('no fresh proof: the options answer 403 reauth_required', async () => {
        const user = await newUser()
        const session = fakeSession({})
        const options = await passkeyService.registerOptions(request(user, session))
        expect(options.status === 'error' && options.error).toMatchObject({
            reason: 'reauth_required',
        })
    })

    it('removing a passkey: the last factor takes the codes; the last way in is refused', async () => {
        const user = await newUser()
        const session = fakeSession(freshPassword())
        const { enrollmentId, response } = await optionsAndAnswer(user, session)
        await passkeyService.register(request(user, session), { enrollmentId, response })
        const [key] = await keysOf(user.id)
        if (key === undefined) throw new Error('no key')

        const withPasskey = fakeSession(freshPasskey())
        const removed = await passkeyService.remove(request(user, withPasskey), key.id)
        expect(removed).toMatchObject({ status: 'ok', value: { mfaDisabled: true } })
        expect(
            await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id)),
        ).toEqual([])
        expect(await eventsOf(user.id, 'auth.passkey.removed')).toHaveLength(1)

        // An account with nothing but this passkey keeps it.
        const passwordless = await newUser({ password: null })
        const only = await storeKeys(passwordless.id, ['Only'])
        const last = await passkeyService.remove(
            request(passwordless, fakeSession(freshPasskey())),
            only[0]!,
        )
        expect(last.status === 'error' && last.error).toMatchObject({
            reason: 'last_sign_in_method',
        })
        expect(await keysOf(passwordless.id)).toHaveLength(1)
    })

    it('two concurrent removals of the last two passkeys of a passwordless account: one wins', async () => {
        const user = await newUser({ password: null })
        // Two keys stored directly: this test is about the removal.
        const ids = await storeKeys(user.id, ['A', 'B'])
        const [a, b] = ids as [PasskeyId, PasskeyId]
        const results = await Promise.all([
            passkeyService.remove(request(user, fakeSession(freshPasskey())), a),
            passkeyService.remove(request(user, fakeSession(freshPasskey())), b),
        ])
        const statuses = results.map((result) => result.status).sort()
        expect(statuses).toEqual(['error', 'ok'])
        const failed = results.find((result) => result.status === 'error')
        expect(failed?.status === 'error' && failed.error).toMatchObject({
            reason: 'last_sign_in_method',
        })
        expect(await keysOf(user.id)).toHaveLength(1)
    })
})
