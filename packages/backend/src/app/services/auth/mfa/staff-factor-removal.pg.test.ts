import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import type { Role } from 'shared/access'
import type { StaffFactorMode } from 'shared/mfa'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import { testAdminActor, testUserActor } from '../../../../test-support/audit-actor.js'
import type { Session, SessionData, SessionInfo } from '#vendor/types/types.js'

// feat-248 (docs/plan/passkeys-mfa-plan.md, Р12; tasks X2) on a real PostgreSQL: removing a
// factor of a staff account while MFA_REQUIRED_FOR_STAFF is on keeps the factor its role needs,
// counted on the state after the change under the user's row lock, in both modes of
// MFA_STAFF_FACTOR. `any`: a passkey may go while TOTP stays, the last factor may not. `passkey`:
// TOTP may go while a passkey stays, the last passkey may not, even with TOTP. The reset by an
// administrator or the CLI is the exception in both modes. An account without a staff role, or
// with the rule off, removes what it likes.

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
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))
vi.mock('#app/services/notifications/email-service.js', () => ({
    emailService: { send: () => Promise.resolve({ status: 'ok', value: { id: 'm' } }) },
}))
vi.mock('#app/services/auth/ws-session-revocation.js', () => ({
    wsSessionRevocation: { closeUserConnections: vi.fn(() => 0) },
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', async (importActual) => ({
    ...(await importActual<Record<string, unknown>>()),
    destroyAllSessions: vi.fn(() => Promise.resolve({ deleted: 0, complete: true })),
}))
// The mode is switched per test: every consumer reads it through staffPolicy() on each call.
vi.mock('#config/mfa.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return { default: { ...actual.default, requiredForStaff: true, staffFactor: 'any' } }
})

describe.skipIf(!hasPg)(
    'factor removal of a staff account in both modes (feat-248 X2)',
    async () => {
        const { db, pool } = await import('#database/db.js')
        const { users } = await import('#database/schema.js')
        const { totpFactorRepository, webauthnCredentialRepository, withTransaction } =
            await import('#app/repositories/index.js')
        const { totpService } = await import('./totp-service.js')
        const { passkeyService } = await import('./passkey-service.js')
        const { mfaResetService } = await import('./mfa-reset-service.js')
        const { loadMfaFactors } = await import('./mfa-account.js')
        const { systemActor } = await import('#app/services/audit/audit-actor.js')
        const { appErrorToPayload } = await import('#app/services/shared/app-error-payload.js')
        const { default: mfaConfig } = (await import('#config/mfa.js')) as unknown as {
            default: { requiredForStaff: boolean; staffFactor: StaffFactorMode }
        }

        const created: bigint[] = []
        afterEach(() => {
            mfaConfig.requiredForStaff = true
            mfaConfig.staffFactor = 'any'
        })
        afterAll(async () => {
            for (const id of created) await db.delete(users).where(eq(users.id, id))
            await pool.end()
        })

        const NOW = Date.now()
        const iso = (offsetSeconds = 0): string =>
            new Date(NOW + offsetSeconds * 1000).toISOString()

        interface TestUser {
            id: bigint
            sessionToken: string
        }

        /** A verified account with a password and the given factors. */
        const account = async (
            role: Role,
            factors: { totp?: boolean; passkeys?: number },
        ): Promise<TestUser & { keys: bigint[] }> => {
            const [user] = await db
                .insert(users)
                .values({
                    name: 'staff-factors',
                    email: `staff-factors-${crypto.randomUUID()}@example.test`,
                    emailVerifiedAt: new Date(),
                    password: 'hash',
                    role,
                })
                .returning({ id: users.id, sessionToken: users.sessionToken })
            if (user === undefined) throw new Error('user not inserted')
            created.push(user.id)
            const keys = await withTransaction(async (tx) => {
                if (factors.totp === true) {
                    // The secret is never read by a removal: a placeholder stands for it.
                    await totpFactorRepository.replace(
                        {
                            userId: user.id,
                            enrollmentId: crypto.randomUUID().slice(0, 32),
                            secretCiphertext: Buffer.from([1]),
                            keyId: 'k1',
                            lastUsedStep: 0n,
                            confirmedAt: new Date(),
                        },
                        tx,
                    )
                }
                const ids: bigint[] = []
                for (let index = 0; index < (factors.passkeys ?? 0); index += 1) {
                    const row = await webauthnCredentialRepository.insert(
                        {
                            userId: user.id,
                            credentialId: Buffer.from(crypto.randomUUID()),
                            publicKey: Buffer.from([1]),
                            signCount: 0n,
                            transports: null,
                            aaguid: null,
                            deviceType: 'multiDevice',
                            backedUp: true,
                            name: `Key ${String(index + 1)}`,
                            enrollmentId: crypto.randomUUID().replaceAll('-', ''),
                        },
                        tx,
                    )
                    ids.push(row.id)
                }
                return ids
            })
            return { ...user, keys }
        }

        /** A session that proved both factors a moment ago (row 3 of Р3 asks for a fresh factor). */
        const freshSession = (): Session => {
            const data: SessionData = {
                auth: {
                    v: 1,
                    amr: ['webauthn'],
                    aal: 2,
                    authenticatedAt: iso(-60),
                    verified: { pwd: iso(-10), otp: iso(-10), webauthn: iso(-10) },
                },
            }
            return {
                sessionInfo: {
                    id: `s-${crypto.randomUUID()}`,
                    data,
                    createdAt: iso(),
                } as SessionInfo,
            } as unknown as Session
        }

        const request = (user: TestUser) => ({
            userId: user.id,
            session: freshSession(),
            presentedSessionToken: user.sessionToken,
            actor: testUserActor(user.id),
            now: NOW,
        })

        const reasonOf = (result: { status: string }): string | undefined =>
            result.status === 'ok'
                ? undefined
                : appErrorToPayload(
                      (result as unknown as { error: Parameters<typeof appErrorToPayload>[0] })
                          .error,
                  ).reason

        const factorsOf = async (userId: bigint) => {
            const factors = await loadMfaFactors(userId)
            return { totp: factors.totp !== undefined, passkeys: factors.passkeys }
        }

        describe('MFA_STAFF_FACTOR=any', () => {
            it('a passkey may go while TOTP stays; the last factor may not', async () => {
                const staff = await account('admin', { totp: true, passkeys: 1 })
                const removed = await passkeyService.remove(request(staff), staff.keys[0] ?? 0n)
                expect(removed.status).toBe('ok')

                const disabled = await totpService.disable(request(staff))
                expect(reasonOf(disabled)).toBe('mfa_required_for_role')
                expect(await factorsOf(staff.id)).toEqual({ totp: true, passkeys: 0 })
            })

            it('TOTP may go while a passkey stays; the last passkey may not', async () => {
                const staff = await account('support_operator', { totp: true, passkeys: 1 })
                expect((await totpService.disable(request(staff))).status).toBe('ok')

                const removed = await passkeyService.remove(request(staff), staff.keys[0] ?? 0n)
                expect(reasonOf(removed)).toBe('mfa_required_for_role')
                expect(await factorsOf(staff.id)).toEqual({ totp: false, passkeys: 1 })
            })
        })

        describe('MFA_STAFF_FACTOR=passkey', () => {
            it('TOTP may go while a passkey stays', async () => {
                mfaConfig.staffFactor = 'passkey'
                const staff = await account('admin', { totp: true, passkeys: 1 })
                expect((await totpService.disable(request(staff))).status).toBe('ok')
                expect(await factorsOf(staff.id)).toEqual({ totp: false, passkeys: 1 })
            })

            it('the last passkey may not go, even with TOTP; another passkey may', async () => {
                mfaConfig.staffFactor = 'passkey'
                const staff = await account('kb_editor', { totp: true, passkeys: 2 })
                expect(
                    (await passkeyService.remove(request(staff), staff.keys[0] ?? 0n)).status,
                ).toBe('ok')
                const last = await passkeyService.remove(request(staff), staff.keys[1] ?? 0n)
                expect(reasonOf(last)).toBe('mfa_required_for_role')
                expect(await factorsOf(staff.id)).toEqual({ totp: true, passkeys: 1 })
            })

            it('a TOTP-only staff account keeps TOTP until it adds a passkey', async () => {
                mfaConfig.staffFactor = 'passkey'
                const staff = await account('admin', { totp: true })
                expect(reasonOf(await totpService.disable(request(staff)))).toBe(
                    'mfa_required_for_role',
                )
                expect(await factorsOf(staff.id)).toEqual({ totp: true, passkeys: 0 })
            })
        })

        it.each<StaffFactorMode>(['any', 'passkey'])(
            'MFA_STAFF_FACTOR=%s: an account without a staff role, or with the rule off, removes its last factor',
            async (mode) => {
                mfaConfig.staffFactor = mode
                const user = await account('user', { passkeys: 1 })
                expect(
                    (await passkeyService.remove(request(user), user.keys[0] ?? 0n)).status,
                ).toBe('ok')

                mfaConfig.requiredForStaff = false
                const staff = await account('admin', { totp: true })
                expect((await totpService.disable(request(staff))).status).toBe('ok')
            },
        )

        it.each<StaffFactorMode>(['any', 'passkey'])(
            'MFA_STAFF_FACTOR=%s: the reset by an administrator and by the CLI is the exception',
            async (mode) => {
                mfaConfig.staffFactor = mode
                // The administrator's own session: a fresh passkey answers rows 9–10 in both modes.
                const admin = await account('admin', { passkeys: 1 })
                const byAdmin = await account('admin', { totp: true, passkeys: 1 })
                const reset = await mfaResetService.reset({
                    actor: { ...testAdminActor(admin.id), role: 'admin' },
                    targetUserId: byAdmin.id,
                    reason: 'lost every factor',
                    sessionAuth: {
                        v: 1,
                        amr: ['webauthn'],
                        aal: 2,
                        authenticatedAt: new Date().toISOString(),
                        verified: { webauthn: new Date().toISOString() },
                    },
                })
                expect(reset.status).toBe('ok')
                expect(await factorsOf(byAdmin.id)).toEqual({ totp: false, passkeys: 0 })

                const byCli = await account('support_operator', { totp: true, passkeys: 2 })
                const cli = await mfaResetService.reset({
                    actor: systemActor('cli'),
                    targetUserId: byCli.id,
                    reason: 'lost every factor',
                })
                expect(cli.status).toBe('ok')
                expect(await factorsOf(byCli.id)).toEqual({ totp: false, passkeys: 0 })
            },
        )
    },
)
