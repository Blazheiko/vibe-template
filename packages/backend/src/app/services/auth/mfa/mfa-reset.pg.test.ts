import { execFile } from 'node:child_process'
import type { NormalizedEmail } from '#app/domain/email.js'
import type { SessionToken } from '#app/domain/secrets.js'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import { testAdminActor } from '../../../../test-support/audit-actor.js'
import { waitForLockWaiters } from '../../../../test-support/race-barrier.js'
import { REDIS_TEST_URL } from '../../../../test-support/redis-test-client.js'
import type { UserId } from '#app/domain/ids.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р12, Р13; tasks S2) on a real PostgreSQL: an
// administrator resets the factors of an account with a password and TOTP: the factor and the
// codes go, the session token rotates, and the password then signs in without a second step; the
// own account and a session without a fresh proof are refused; an account left without a way to
// sign in (only a passkey) is refused without exception; the real CLI process does the same.

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
const closed = vi.hoisted(() => vi.fn(() => 0))
vi.mock('#app/services/auth/ws-session-revocation.js', () => ({
    wsSessionRevocation: { closeUserConnections: closed },
}))
const destroyed = vi.hoisted(() => vi.fn(() => Promise.resolve({ deleted: 0, complete: true })))
vi.mock('#vendor/utils/session/redis-session-storage.js', async (importActual) => ({
    ...(await importActual<Record<string, unknown>>()),
    destroyAllSessions: destroyed,
}))

const run = promisify(execFile)
const BACKEND = fileURLToPath(new URL('../../../../../', import.meta.url))

describe.skipIf(!hasPg)('MFA reset by an administrator and the CLI (feat-247 S2)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, totpFactors, mfaRecoveryCodes, auditEvents, webauthnCredentials } =
        await import('#database/schema.js')
    const { totpFactorRepository, withTransaction } = await import('#app/repositories/index.js')
    const { recoveryCodes } = await import('./recovery-codes.js')
    const { mfaResetService } = await import('./mfa-reset-service.js')
    const { loadMfaFactors } = await import('./mfa-account.js')
    const { appErrorToPayload } = await import('#app/services/shared/app-error-payload.js')

    const created: UserId[] = []
    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })

    const insertUser = async (fields: { role?: 'user' | 'admin'; password?: string | null }) => {
        const [row] = await db
            .insert(users)
            .values({
                name: 'mfa-reset',
                email: `mfa-reset-${crypto.randomUUID()}@example.test` as NormalizedEmail,
                emailVerifiedAt: new Date(),
                password: fields.password === undefined ? 'hash' : fields.password,
                role: fields.role ?? 'user',
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        created.push(row.id)
        return row
    }

    const withTotp = async (userId: UserId) => {
        await withTransaction(async (tx) => {
            await totpFactorRepository.replace(
                {
                    userId,
                    enrollmentId: crypto.randomUUID().slice(0, 32),
                    secretCiphertext: Buffer.from([1]),
                    keyId: 'k1',
                    lastUsedStep: 0n,
                    confirmedAt: new Date(),
                },
                tx,
            )
            await recoveryCodes.issue(userId, tx)
        })
    }

    const freshAdminAuth = () => {
        const at = new Date().toISOString()
        return {
            v: 1 as const,
            amr: ['pwd' as const],
            aal: 1 as const,
            authenticatedAt: at,
            verified: { pwd: at },
        }
    }
    const actorOf = (admin: { id: UserId }) => ({
        ...testAdminActor(admin.id),
        role: 'admin' as const,
    })
    const payloadOf = (result: unknown) =>
        appErrorToPayload((result as { error: Parameters<typeof appErrorToPayload>[0] }).error)
    const tokenOf = async (id: UserId) =>
        (await db.select().from(users).where(eq(users.id, id)))[0]?.sessionToken

    it('removes TOTP and the codes, rotates the token, ends the sessions; no second step after', async () => {
        const admin = await insertUser({ role: 'admin' })
        const target = await insertUser({})
        await withTotp(target.id)
        const before = await tokenOf(target.id)

        const result = await mfaResetService.reset({
            actor: actorOf(admin),
            presentedSessionToken: admin.sessionToken,
            sessionStored: () => Promise.resolve(true),
            targetUserId: target.id,
            reason: 'lost phone and codes',
            sessionAuth: freshAdminAuth(),
        })
        expect(result).toMatchObject({
            status: 'ok',
            value: { removed: { totp: true, passkeys: 0, recoveryCodes: 10 } },
        })
        expect(
            await db.select().from(totpFactors).where(eq(totpFactors.userId, target.id)),
        ).toEqual([])
        expect(
            await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, target.id)),
        ).toEqual([])
        expect(await tokenOf(target.id)).not.toBe(before)
        expect(closed).toHaveBeenCalledWith(target.id)
        // The records live under the token the account had before the rotation.
        expect(destroyed).toHaveBeenCalledWith(before)
        expect(security).toHaveBeenCalledWith(target.id, 'mfa_reset')
        // The next password sign-in has no second step; a new factor can be set up (row 1).
        expect(await loadMfaFactors(target.id)).toEqual({ totp: undefined, passkeys: 0 })
        const [event] = await db
            .select()
            .from(auditEvents)
            .where(
                and(
                    eq(auditEvents.targetUserId, target.id),
                    eq(auditEvents.action, 'auth.mfa.reset'),
                ),
            )
        expect(event).toMatchObject({
            actorKind: 'user',
            actorUserId: admin.id,
            metadata: { reason: 'lost phone and codes', mfaRemoved: true, proof: 'password' },
        })
    })

    it('the own account is refused: a recovery code or the CLI is the way', async () => {
        const admin = await insertUser({ role: 'admin' })
        await withTotp(admin.id)
        const result = await mfaResetService.reset({
            actor: actorOf(admin),
            presentedSessionToken: admin.sessionToken,
            sessionStored: () => Promise.resolve(true),
            targetUserId: admin.id,
            reason: 'my own factors',
            sessionAuth: freshAdminAuth(),
        })
        expect(payloadOf(result)).toMatchObject({ code: 'forbidden' })
        expect((await loadMfaFactors(admin.id)).totp).toBeDefined()
    })

    it('a session without a fresh proof gets 403 reauth_required; nothing is removed', async () => {
        const admin = await insertUser({ role: 'admin' })
        const target = await insertUser({})
        await withTotp(target.id)
        const result = await mfaResetService.reset({
            actor: actorOf(admin),
            presentedSessionToken: admin.sessionToken,
            sessionStored: () => Promise.resolve(true),
            targetUserId: target.id,
            reason: 'lost phone',
            sessionAuth: undefined,
        })
        expect(payloadOf(result)).toMatchObject({ reason: 'reauth_required' })
        expect((await loadMfaFactors(target.id)).totp).toBeDefined()
    })

    it('an account with nothing but a passkey: 409 last_sign_in_method, no exception', async () => {
        const admin = await insertUser({ role: 'admin' })
        const target = await insertUser({ password: null })
        await db.insert(webauthnCredentials).values({
            userId: target.id,
            credentialId: Buffer.from(crypto.randomUUID()),
            publicKey: Buffer.from([1]),
            deviceType: 'multiDevice',
            backedUp: true,
            name: 'Only',
            enrollmentId: crypto.randomUUID().replaceAll('-', ''),
        })
        const result = await mfaResetService.reset({
            actor: actorOf(admin),
            presentedSessionToken: admin.sessionToken,
            sessionStored: () => Promise.resolve(true),
            targetUserId: target.id,
            reason: 'lost the passkey',
            sessionAuth: freshAdminAuth(),
        })
        expect(payloadOf(result)).toMatchObject({ reason: 'last_sign_in_method' })
        expect((await loadMfaFactors(target.id)).passkeys).toBe(1)
    })

    // Review of feat-247, item 4: the admin is checked again at the write, under its row lock.
    describe('the admin at the write', () => {
        const freshTotpAuth = () => {
            const at = new Date().toISOString()
            return {
                v: 1 as const,
                amr: ['pwd' as const, 'otp' as const],
                aal: 2 as const,
                authenticatedAt: at,
                verified: { pwd: at, otp: at },
            }
        }

        it('a session token rotated after the request came in: 401 session_revoked, nothing removed', async () => {
            const admin = await insertUser({ role: 'admin' })
            const target = await insertUser({})
            await withTotp(target.id)
            const targetToken = await tokenOf(target.id)
            // Logout everywhere (or a password change) of the admin, after its request was let in.
            await db
                .update(users)
                .set({ sessionToken: 'rotated-admin-token' as SessionToken })
                .where(eq(users.id, admin.id))

            const result = await mfaResetService.reset({
                actor: actorOf(admin),
                presentedSessionToken: admin.sessionToken,
                sessionStored: () => Promise.resolve(true),
                targetUserId: target.id,
                reason: 'lost phone',
                sessionAuth: freshAdminAuth(),
            })
            expect(payloadOf(result)).toMatchObject({
                code: 'unauthorized',
                reason: 'session_revoked',
            })
            expect((await loadMfaFactors(target.id)).totp).toBeDefined()
            expect(await tokenOf(target.id)).toBe(targetToken)
        })

        it('an admin lowered after the guard: 403, nothing removed', async () => {
            const admin = await insertUser({ role: 'admin' })
            const target = await insertUser({})
            await withTotp(target.id)
            await db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id))

            const result = await mfaResetService.reset({
                actor: actorOf(admin),
                presentedSessionToken: admin.sessionToken,
                sessionStored: () => Promise.resolve(true),
                targetUserId: target.id,
                reason: 'lost phone',
                sessionAuth: freshAdminAuth(),
            })
            expect(payloadOf(result)).toMatchObject({ code: 'forbidden' })
            expect((await loadMfaFactors(target.id)).totp).toBeDefined()
        })

        it('two admins resetting each other at once: no deadlock, the second finds its session revoked', async () => {
            const first = await insertUser({ role: 'admin' })
            const second = await insertUser({ role: 'admin' })
            await withTotp(first.id)
            await withTotp(second.id)
            const resetOther = (actor: typeof first, target: typeof first) =>
                mfaResetService.reset({
                    actor: actorOf(actor),
                    presentedSessionToken: actor.sessionToken,
                    sessionStored: () => Promise.resolve(true),
                    targetUserId: target.id,
                    reason: 'crossed resets',
                    sessionAuth: freshTotpAuth(),
                })

            let one: ReturnType<typeof resetOther> | undefined
            let two: ReturnType<typeof resetOther> | undefined
            // The test holds both rows, so both resets are inside their transactions, waiting
            // for the same lock, before either goes on.
            await db.transaction(async (tx) => {
                await tx.execute(
                    sql`SELECT id FROM users WHERE id IN (${first.id}, ${second.id}) ORDER BY id FOR UPDATE`,
                )
                one = resetOther(first, second)
                two = resetOther(second, first)
                await waitForLockWaiters((q) => pool.query(q), 2)
            })
            if (one === undefined || two === undefined) throw new Error('not started')
            const results = await Promise.all([one, two])

            const ok = results.filter((result) => result.status === 'ok')
            expect(ok).toHaveLength(1)
            const refused = results.find((result) => result.status !== 'ok')
            expect(payloadOf(refused)).toMatchObject({ reason: 'session_revoked' })
            const factors = [
                (await loadMfaFactors(first.id)).totp,
                (await loadMfaFactors(second.id)).totp,
            ]
            expect(factors.filter((totp) => totp === undefined)).toHaveLength(1)
        })
    })

    it('the real CLI process resets the last administrator and records a cli event', async () => {
        const admin = await insertUser({ role: 'admin' })
        await withTotp(admin.id)
        const redis = new URL(REDIS_TEST_URL ?? 'redis://127.0.0.1:6379')
        const { stdout } = await run(
            'pnpm',
            [
                'exec',
                'tsx',
                'src/scripts/user-mfa-reset.ts',
                '--email',
                admin.email ?? '',
                '--reason',
                'last admin lost the phone',
            ],
            {
                cwd: BACKEND,
                env: { ...process.env, REDIS_HOST: redis.hostname, REDIS_PORT: redis.port },
                timeout: 60_000,
            },
        )
        expect(stdout).toContain('second factors reset')
        expect((await loadMfaFactors(admin.id)).totp).toBeUndefined()
        const [event] = await db
            .select()
            .from(auditEvents)
            .where(
                and(
                    eq(auditEvents.targetUserId, admin.id),
                    eq(auditEvents.action, 'auth.mfa.reset'),
                ),
            )
        expect(event).toMatchObject({ actorKind: 'system', metadata: { source: 'cli' } })

        // An unknown address: exit code 1 and a message.
        await expect(
            run(
                'pnpm',
                [
                    'exec',
                    'tsx',
                    'src/scripts/user-mfa-reset.ts',
                    '--email',
                    'nobody@example.test',
                    '--reason',
                    'none here',
                ],
                {
                    cwd: BACKEND,
                    env: { ...process.env, REDIS_HOST: redis.hostname, REDIS_PORT: redis.port },
                    timeout: 60_000,
                },
            ),
        ).rejects.toMatchObject({ code: 1 })
    }, 120_000)
})
