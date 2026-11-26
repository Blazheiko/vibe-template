import { nowUnixMs, addMs, ms } from 'shared/brand'
import { and, eq } from 'drizzle-orm'
import type { NormalizedEmail } from '#app/domain/email.js'
import type { SessionToken } from '#app/domain/secrets.js'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import { testUserActor } from '../../../../test-support/audit-actor.js'
import type { Session, SessionData, SessionInfo } from '#vendor/types/types.js'
import type { UserId } from '#app/domain/ids.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7, tasks M5) against a real PostgreSQL: the TOTP
// confirmation is idempotent by its enrollment id, parallel confirmations leave one version and
// one audit event, a replacement in a recovery session records R+, and the code that confirmed a
// setup does not pass again. The session is an in-memory stand-in with the same contract.

vi.hoisted(() => {
    process.env['MFA_ENCRYPTION_KEYS'] = `k1:${Buffer.alloc(32, 9).toString('base64')}`
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
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
const security = vi.hoisted(() => vi.fn())
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security, supportReply: vi.fn() },
}))

describe.skipIf(!hasPg)('TOTP service on PostgreSQL (feat-245 M5)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, totpFactors, auditEvents, mfaRecoveryCodes } =
        await import('#database/schema.js')
    const { totpService, TOTP_ENROLLMENT_KEY } = await import('./totp-service.js')
    const { base32Decode, hotp, totpStepAt } = await import('./totp.js')
    const { mergeSessionAuth, sessionAuthOf } = await import('shared/mfa')

    const created: UserId[] = []
    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })
    beforeEach(() => {
        security.mockClear()
    })

    const NOW = nowUnixMs()
    const iso = (offsetSeconds = 0): string => new Date(NOW + offsetSeconds * 1000).toISOString()

    const newUser = async (): Promise<{ id: UserId; sessionToken: SessionToken }> => {
        const [user] = await db
            .insert(users)
            .values({
                name: 'totp',
                email: `${crypto.randomUUID()}@example.test` as NormalizedEmail,
                emailVerifiedAt: new Date(),
                password: 'hash',
            })
            .returning({ id: users.id, sessionToken: users.sessionToken })
        if (user === undefined) throw new Error('user not inserted')
        created.push(user.id)
        return user
    }

    /** An in-memory session with the store's contract (updateSessionAuth merges, keeps data). */
    const fakeSession = (data: SessionData): Session & { failNextAuthWrite: () => void } => {
        let failNext = false
        const session = {
            sessionInfo: { id: 's', data, createdAt: iso() } as SessionInfo,
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
            // feat-258: as the store does it: the keys go only while every expected value is held.
            consumeSessionData: (expected: Record<string, string>, keys: readonly string[]) => {
                const data = { ...session.sessionInfo.data } as Record<string, unknown>
                if (!Object.entries(expected).every(([key, value]) => data[key] === value)) {
                    return Promise.resolve('mismatch' as const)
                }
                for (const key of keys) delete data[key]
                session.sessionInfo = { ...session.sessionInfo, data: data }
                return Promise.resolve('consumed' as const)
            },
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

    const freshPassword = {
        v: 1 as const,
        amr: ['pwd' as const],
        aal: 1 as const,
        authenticatedAt: iso(-60),
        verified: { pwd: iso(-10) },
    }

    const request = (user: { id: UserId; sessionToken: SessionToken }, session: Session) => ({
        userId: user.id,
        session,
        presentedSessionToken: user.sessionToken,
        actor: testUserActor(user.id),
        now: NOW,
    })

    const factorsOf = (userId: UserId) =>
        db.select().from(totpFactors).where(eq(totpFactors.userId, userId))

    const setupAndCode = async (
        user: { id: UserId; sessionToken: SessionToken },
        session: Session,
        stepOffset = 0n,
    ) => {
        const setup = await totpService.setup(request(user, session))
        if (setup.status !== 'ok') throw new Error(JSON.stringify(setup.error))
        const code = hotp(base32Decode(setup.value.secret), totpStepAt(NOW) + stepOffset)
        return { enrollmentId: setup.value.enrollmentId, code }
    }

    it('a first factor needs a fresh password, then confirms with ten recovery codes', async () => {
        const user = await newUser()
        const stale = fakeSession({ auth: { ...freshPassword, verified: { pwd: iso(-3600) } } })
        const refused = await totpService.setup(request(user, stale))
        expect(refused.status).toBe('error')

        const session = fakeSession({ auth: freshPassword })
        const { enrollmentId, code } = await setupAndCode(user, session)
        const confirmed = await totpService.confirm(request(user, session), { enrollmentId, code })
        expect(confirmed.status).toBe('ok')
        if (confirmed.status !== 'ok') return
        expect(confirmed.value.recoveryCodes).toHaveLength(10)
        expect(session.sessionInfo?.data[TOTP_ENROLLMENT_KEY]).toBeUndefined()
        expect(security).toHaveBeenCalledWith(user.id, 'mfa_enabled')
        const unused = await db
            .select()
            .from(mfaRecoveryCodes)
            .where(eq(mfaRecoveryCodes.userId, user.id))
        expect(unused).toHaveLength(10)
    })

    // Р14: the confirmation records the proof the setup accepted, kept with the setup in the
    // session, not one decided again from the marks and the factors of the confirmation.
    // feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 3): the proof the setup kept is
    // checked again under the lock, against the account as it is when the factor is written.
    it('a password set since the setup: the kept recent sign-in no longer admits the factor', async () => {
        const [user] = await db
            .insert(users)
            .values({
                name: 'totp',
                email: `${crypto.randomUUID()}@example.test` as NormalizedEmail,
                emailVerifiedAt: new Date(),
                password: null,
            })
            .returning({ id: users.id, sessionToken: users.sessionToken })
        if (user === undefined) throw new Error('user not inserted')
        created.push(user.id)
        // No password: a recent social sign-in is the proof of the setup.
        const session = fakeSession({
            auth: {
                v: 1,
                amr: ['oauth'],
                aal: 1,
                authenticatedAt: iso(-10),
                verified: { oauth: iso(-10) },
            },
        })
        const { enrollmentId, code } = await setupAndCode(user, session)
        // Meanwhile a password appears: the matrix now asks for it.
        await db.update(users).set({ password: 'hash' }).where(eq(users.id, user.id))

        const confirmed = await totpService.confirm(request(user, session), { enrollmentId, code })
        expect(confirmed.status === 'error' && confirmed.error).toMatchObject({
            reason: 'reauth_required',
        })
        expect(await factorsOf(user.id)).toHaveLength(0)
    })

    // feat-258 (docs/plan/mfa-review-fixes-7-plan.md, 8.4): a refused setup is removed for its
    // enrollment id, so it cannot pass later when the factors allow its kept proof again.
    it('a refused setup is removed: it does not pass once the factors allow its proof again', async () => {
        const [user] = await db
            .insert(users)
            .values({
                name: 'totp',
                email: `${crypto.randomUUID()}@example.test` as NormalizedEmail,
                emailVerifiedAt: new Date(),
                password: null,
            })
            .returning({ id: users.id, sessionToken: users.sessionToken })
        if (user === undefined) throw new Error('user not inserted')
        created.push(user.id)
        const session = fakeSession({
            auth: {
                v: 1,
                amr: ['oauth'],
                aal: 1,
                authenticatedAt: iso(-10),
                verified: { oauth: iso(-10) },
            },
        })
        const { enrollmentId, code } = await setupAndCode(user, session)
        expect(session.sessionInfo?.data['totpEnrollmentId']).toBe(enrollmentId)
        await db.update(users).set({ password: 'hash' }).where(eq(users.id, user.id))
        const refused = await totpService.confirm(request(user, session), { enrollmentId, code })
        expect(refused.status === 'error' && refused.error).toMatchObject({
            reason: 'reauth_required',
        })
        // Gone with its id, both keys.
        expect(session.sessionInfo?.data['totpEnrollment']).toBeUndefined()
        expect(session.sessionInfo?.data['totpEnrollmentId']).toBeUndefined()

        // The password goes again: the kept recent sign-in would admit it now, but the setup is gone.
        await db.update(users).set({ password: null }).where(eq(users.id, user.id))
        const again = await totpService.confirm(request(user, session), { enrollmentId, code })
        expect(again.status === 'error' && again.error).toMatchObject({
            reason: 'enrollment_not_found',
        })
        expect(await factorsOf(user.id)).toHaveLength(0)
    })

    it('TOTP turned on in another session since a password setup: the setup replaces nothing', async () => {
        const user = await newUser()
        const first = fakeSession({ auth: freshPassword })
        const pending = await setupAndCode(user, first)
        // Another session of the same user turns TOTP on (a password proof, no MFA yet).
        const second = fakeSession({ auth: freshPassword })
        const other = await setupAndCode(user, second, 1n)
        const enabled = await totpService.confirm(request(user, second), other)
        expect(enabled.status).toBe('ok')

        // The first setup was allowed by a password; with TOTP on, only a factor proves the owner.
        const replaced = await totpService.confirm(request(user, first), pending)
        expect(replaced.status === 'error' && replaced.error).toMatchObject({
            reason: 'reauth_required',
        })
        const factors = await factorsOf(user.id)
        expect(factors.map((factor) => factor.enrollmentId)).toEqual([other.enrollmentId])
    })

    it('a recovery session that ended between the setup and the confirmation: refused', async () => {
        const user = await newUser()
        const session = fakeSession({
            auth: {
                v: 1,
                amr: ['pwd', 'recovery'],
                aal: 1,
                authenticatedAt: iso(-60),
                verified: { pwd: iso(-60) },
                recovery: { startedAt: iso(-60), expiresAt: iso(60) },
            },
        })
        // Two minutes later (four TOTP steps): the recovery window closed meanwhile.
        const { enrollmentId, code } = await setupAndCode(user, session, 4n)
        const confirmed = await totpService.confirm(
            { ...request(user, session), now: addMs(NOW, ms(120_000)) },
            { enrollmentId, code },
        )
        expect(confirmed.status === 'error' && confirmed.error).toMatchObject({
            reason: 'recovery_session',
        })
        expect(await factorsOf(user.id)).toHaveLength(0)
    })

    it('a setup stored without its proof (before it was kept) is started again, nothing written', async () => {
        const user = await newUser()
        const session = fakeSession({ auth: freshPassword })
        const { enrollmentId, code } = await setupAndCode(user, session)
        const { proof: _proof, ...withoutProof } = session.sessionInfo?.data[
            TOTP_ENROLLMENT_KEY
        ] as Record<string, unknown>
        await session.updateSessionData({ [TOTP_ENROLLMENT_KEY]: withoutProof })

        const confirmed = await totpService.confirm(request(user, session), { enrollmentId, code })
        expect(confirmed.status === 'error' && confirmed.error).toMatchObject({
            reason: 'enrollment_not_found',
        })
        expect(
            await db.select().from(totpFactors).where(eq(totpFactors.userId, user.id)),
        ).toHaveLength(0)
    })

    it('the code that confirmed the setup does not pass again as a second factor', async () => {
        const user = await newUser()
        const session = fakeSession({ auth: freshPassword })
        const { enrollmentId, code } = await setupAndCode(user, session)
        await totpService.confirm(request(user, session), { enrollmentId, code })
        const again = await totpService.verify(user.id, code, { now: NOW })
        expect(again.status).toBe('error')
    })

    it('two parallel confirmations of one setup leave one version and one audit event', async () => {
        const user = await newUser()
        const session = fakeSession({ auth: freshPassword })
        const { enrollmentId, code } = await setupAndCode(user, session)
        const results = await Promise.all([
            totpService.confirm(request(user, session), { enrollmentId, code }),
            totpService.confirm(request(user, session), { enrollmentId, code }),
        ])
        expect(results.every((result) => result.status === 'ok')).toBe(true)
        const versions = await db.select().from(totpFactors).where(eq(totpFactors.userId, user.id))
        expect(versions).toHaveLength(1)
        const events = await db
            .select()
            .from(auditEvents)
            .where(
                and(
                    eq(auditEvents.targetUserId, user.id),
                    eq(auditEvents.action, 'auth.mfa.totp.enabled'),
                ),
            )
        expect(events).toHaveLength(1)
        expect(events[0]?.metadata).toMatchObject({ proof: 'password' })
    })

    // feat-259 (docs/plan/mfa-review-fixes-7-plan.md, 9.2): a setup stored without its id key
    // (before feat-258) cannot be removed for its id after a refusal, so it is set up again.
    it('a setup without its id key is set up again; nothing is written', async () => {
        const user = await newUser()
        const session = fakeSession({ auth: freshPassword })
        const { enrollmentId, code } = await setupAndCode(user, session)
        await session.updateSessionData({ totpEnrollmentId: undefined })
        const confirmed = await totpService.confirm(request(user, session), { enrollmentId, code })
        expect(confirmed.status === 'error' && confirmed.error).toMatchObject({
            reason: 'enrollment_not_found',
        })
        expect(await factorsOf(user.id)).toHaveLength(0)
    })

    it('a committed setup without its id key still finishes its session write (R+)', async () => {
        const user = await newUser()
        const first = fakeSession({ auth: freshPassword })
        const initial = await setupAndCode(user, first)
        await totpService.confirm(request(user, first), initial)
        const recovery = fakeSession({
            auth: {
                v: 1,
                amr: ['pwd', 'recovery'],
                aal: 1,
                authenticatedAt: iso(-30),
                verified: { pwd: iso(-30) },
                recovery: { startedAt: iso(-30), expiresAt: iso(870) },
            },
        })
        const { enrollmentId, code } = await setupAndCode(user, recovery, 1n)
        recovery.failNextAuthWrite()
        await expect(
            totpService.confirm(request(user, recovery), { enrollmentId, code }),
        ).rejects.toThrow(/Redis down/)
        // The session lost the id key meanwhile (a setup stored the old way).
        await recovery.updateSessionData({ totpEnrollmentId: undefined })
        const repeated = await totpService.confirm(request(user, recovery), {
            enrollmentId,
            code: '000000',
        })
        expect(repeated.status).toBe('ok')
        expect(recovery.sessionInfo?.data.auth?.recovery?.replacementFactor).toMatchObject({
            kind: 'totp',
        })
    })

    it('a repeat after a commit whose session write failed records R+ without a second version', async () => {
        const user = await newUser()
        // A recovery session: TOTP already on (the lost phone), replaced here.
        const first = fakeSession({ auth: freshPassword })
        const initial = await setupAndCode(user, first)
        await totpService.confirm(request(user, first), initial)

        const recovery = fakeSession({
            auth: {
                v: 1,
                amr: ['pwd', 'recovery'],
                aal: 1,
                authenticatedAt: iso(-30),
                verified: { pwd: iso(-30) },
                recovery: { startedAt: iso(-30), expiresAt: iso(870) },
            },
        })
        const { enrollmentId, code } = await setupAndCode(user, recovery, 1n)
        recovery.failNextAuthWrite()
        await expect(
            totpService.confirm(request(user, recovery), { enrollmentId, code }),
        ).rejects.toThrow(/Redis down/)
        expect(recovery.sessionInfo?.data.auth?.recovery?.replacementFactor).toBeUndefined()

        // Same request again: no code check, the committed version becomes R+.
        const repeated = await totpService.confirm(request(user, recovery), {
            enrollmentId,
            code: '000000',
        })
        expect(repeated.status).toBe('ok')
        const versions = await db.select().from(totpFactors).where(eq(totpFactors.userId, user.id))
        expect(versions).toHaveLength(1)
        expect(versions[0]?.enrollmentId).toBe(enrollmentId)
        expect(recovery.sessionInfo?.data.auth?.recovery?.replacementFactor).toMatchObject({
            kind: 'totp',
            id: String(versions[0]?.id),
        })
        const replaced = await db
            .select()
            .from(auditEvents)
            .where(
                and(
                    eq(auditEvents.targetUserId, user.id),
                    eq(auditEvents.action, 'auth.mfa.totp.replaced'),
                ),
            )
        expect(replaced).toHaveLength(1)
        expect(replaced[0]?.metadata).toMatchObject({ proof: 'recovery_code' })
    })

    it('a confirmation of an old setup after a newer replacement does not remove the new version', async () => {
        const user = await newUser()
        const session = fakeSession({ auth: freshPassword })
        const a = await setupAndCode(user, session)
        await totpService.confirm(request(user, session), a)
        // MFA on now: another factor needs a fresh TOTP.
        const withTotp = fakeSession({ auth: { ...freshPassword, verified: { otp: iso(-5) } } })
        const b = await setupAndCode(user, withTotp, 1n)
        await totpService.confirm(request(user, withTotp), b)
        const before = await db.select().from(totpFactors).where(eq(totpFactors.userId, user.id))

        const repeatA = await totpService.confirm(request(user, session), a)
        expect(repeatA.status).toBe('error')
        const after = await db.select().from(totpFactors).where(eq(totpFactors.userId, user.id))
        expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id))
    })

    it('without a verified contact the first factor is refused', async () => {
        const [user] = await db
            .insert(users)
            .values({
                name: 'no contact',
                email: `${crypto.randomUUID()}@example.test` as NormalizedEmail,
                password: 'h',
            })
            .returning({ id: users.id, sessionToken: users.sessionToken })
        if (user === undefined) throw new Error('user not inserted')
        created.push(user.id)
        const result = await totpService.setup(request(user, fakeSession({ auth: freshPassword })))
        expect(result.status).toBe('error')
        if (result.status === 'error') {
            expect(result.error).toMatchObject({ reason: 'recovery_contact_required' })
        }
    })

    it('turning the last factor off removes the recovery codes', async () => {
        const user = await newUser()
        const session = fakeSession({ auth: freshPassword })
        const setup = await setupAndCode(user, session)
        await totpService.confirm(request(user, session), setup)
        const withTotp = fakeSession({ auth: { ...freshPassword, verified: { otp: iso(-5) } } })
        const off = await totpService.disable(request(user, withTotp))
        expect(off.status).toBe('ok')
        if (off.status === 'ok') expect(off.value.mfaDisabled).toBe(true)
        expect(
            await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id)),
        ).toEqual([])
    })
})
