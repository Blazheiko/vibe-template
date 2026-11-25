import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { uid } from '../../../test-support/ids.js'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import type { Role } from 'shared/access'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { auditLogLines, testAdminActor } from '../../../test-support/audit-actor.js'
import type { UserId } from '#app/domain/ids.js'

// feat-240 (Р6, Р7, T5) on a real PostgreSQL: a role change and its audit event commit together
// under one advisory lock; the delegation, verified-email and last-admin rules; a CLI change; the
// two races of the plan.

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
const announceRoleChanged = vi.hoisted(() => vi.fn())
vi.mock('#app/services/communication/role-change-announcer.js', () => ({ announceRoleChanged }))
// feat-247 (Р10): MFA_REQUIRED_FOR_STAFF is on by default; one test turns it off.
vi.mock('#config/mfa.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return { default: { ...actual.default, requiredForStaff: true } }
})

describe.skipIf(!hasPg)('roleAssignmentService on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { auditEvents, users } = await import('#database/schema.js')
    const { auditService } = await import('#app/services/audit/audit-service.js')
    const { systemActor } = await import('#app/services/audit/audit-actor.js')
    const { appErrorToPayload } = await import('#app/services/shared/app-error-payload.js')
    const { roleAssignmentService } = await import('./role-assignment-service.js')
    const { userRepository, totpFactorRepository, withTransaction } =
        await import('#app/repositories/index.js')
    const { default: mfaConfig } = (await import('#config/mfa.js')) as unknown as {
        default: { requiredForStaff: boolean }
    }

    const stamp = String(Date.now())
    const userIds: UserId[] = []
    let counter = 0

    const insertUser = async (role: Role, verified = true): Promise<UserId> => {
        counter += 1
        const [row] = await db
            .insert(users)
            .values({
                name: `role-assign-${String(counter)}`,
                email: `role-assign-${String(counter)}-${stamp}@example.test`,
                emailVerifiedAt: verified ? new Date() : null,
                role,
            })
            .returning({ id: users.id })
        if (row === undefined) throw new Error('user not inserted')
        userIds.push(row.id)
        return row.id
    }

    /**
     * feat-247 (Р10): a confirmed TOTP factor, so the account may get a staff role. The secret is
     * never read here, so a placeholder stands for its ciphertext.
     */
    const addFactor = async (userId: UserId): Promise<UserId> => {
        await withTransaction((tx) =>
            totpFactorRepository.replace(
                {
                    userId,
                    enrollmentId: crypto.randomUUID().slice(0, 32),
                    secretCiphertext: Buffer.from([1]),
                    keyId: 'k1',
                    lastUsedStep: 0n,
                    confirmedAt: new Date(),
                },
                tx,
            ),
        )
        return userId
    }
    /** A user that may be given a staff role: verified, with a second factor. */
    const insertEnrolled = async (role: Role): Promise<UserId> => addFactor(await insertUser(role))

    const roleOf = async (id: UserId): Promise<Role | undefined> => {
        const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, id))
        return row?.role
    }

    const eventsFor = (targetUserId: UserId) =>
        db
            .select()
            .from(auditEvents)
            .where(
                and(
                    eq(auditEvents.targetUserId, targetUserId),
                    eq(auditEvents.action, 'user.role.changed'),
                ),
            )

    /**
     * feat-247 (row 9 of Р3): the session of the admin proved itself a moment ago. The fixtures
     * have no password, so a recent social sign-in is the proof; the tests below vary it.
     */
    const freshAuth = () => {
        const at = new Date().toISOString()
        return {
            v: 1 as const,
            amr: ['oauth' as const],
            aal: 1 as const,
            authenticatedAt: at,
            verified: { oauth: at },
        }
    }
    const tokenOf = async (id: UserId): Promise<string | undefined> =>
        (await db.select({ token: users.sessionToken }).from(users).where(eq(users.id, id)))[0]
            ?.token
    /** As the HTTP layer calls it: a fresh proof and the session token of a user actor. */
    const assign = async (input: Parameters<typeof roleAssignmentService.assign>[0]) =>
        roleAssignmentService.assign({
            sessionAuth: freshAuth(),
            ...(input.actor.kind === 'user'
                ? {
                      presentedSessionToken: await tokenOf(input.actor.userId),
                      sessionStored: () => Promise.resolve(true),
                  }
                : {}),
            ...input,
        })

    /** An actor as the HTTP layer builds it: the guard's role, a request of its own. */
    const actorFor = (userId: UserId, role: Role) => ({ ...testAdminActor(userId), role })

    const payloadOf = (result: { isErr(): boolean; error?: unknown }) =>
        appErrorToPayload(
            (result as unknown as { error: Parameters<typeof appErrorToPayload>[0] }).error,
        )

    afterEach(() => {
        mfaConfig.requiredForStaff = true
        vi.restoreAllMocks()
        announceRoleChanged.mockClear()
    })

    afterAll(async () => {
        if (userIds.length > 0) {
            await db.delete(auditEvents).where(inArray(auditEvents.targetUserId, userIds))
            await db.delete(users).where(inArray(users.id, userIds))
        }
        await pool.end()
    })

    // feat-247 (row 9 of Р3): a role change needs a fresh proof of the admin's session.
    describe('step-up of the admin (feat-247 S1)', () => {
        it('without a fresh proof: 403 reauth_required, nothing changed', async () => {
            const admin = await insertUser('admin')
            await db.update(users).set({ password: 'hash' }).where(eq(users.id, admin))
            const target = await insertUser('user')
            const result = await roleAssignmentService.assign({
                actor: actorFor(admin, 'admin'),
                targetUserId: target,
                role: 'kb_editor',
                sessionAuth: undefined,
            })
            expect(payloadOf(result)).toMatchObject({
                reason: 'reauth_required',
                details: { proofs: ['password'] },
            })
            expect(await roleOf(target)).toBe('user')
        })

        it('an admin with TOTP: the password is not enough, a fresh TOTP is', async () => {
            const admin = await insertUser('admin')
            await db.update(users).set({ password: 'hash' }).where(eq(users.id, admin))
            await addFactor(admin)
            const target = await insertEnrolled('user')
            const at = new Date().toISOString()
            const base = { v: 1 as const, amr: ['pwd' as const], authenticatedAt: at }
            const withPassword = await roleAssignmentService.assign({
                actor: actorFor(admin, 'admin'),
                targetUserId: target,
                role: 'kb_editor',
                sessionAuth: { ...base, aal: 1, verified: { pwd: at } },
            })
            expect(payloadOf(withPassword)).toMatchObject({
                reason: 'reauth_required',
                details: { proofs: ['totp'] },
            })
            const withTotp = await assign({
                actor: actorFor(admin, 'admin'),
                targetUserId: target,
                role: 'kb_editor',
                sessionAuth: {
                    ...base,
                    amr: ['pwd', 'otp'],
                    aal: 2,
                    verified: { pwd: at, otp: at },
                },
            })
            expect(withTotp.isOk()).toBe(true)
            expect((await eventsFor(target))[0]?.metadata).toMatchObject({ proof: 'totp' })
        })
    })

    it('changes the role and writes one event in the same transaction', async () => {
        const admin = await insertUser('admin')
        const target = await insertEnrolled('user')
        const actor = actorFor(admin, 'admin')

        const result = await assign({
            actor,
            targetUserId: target,
            role: 'kb_editor',
        })

        expect(result.isOk()).toBe(true)
        expect(result.isOk() && result.value).toEqual({
            userId: target,
            role: 'kb_editor',
            changed: true,
        })
        expect(await roleOf(target)).toBe('kb_editor')
        const events = await eventsFor(target)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            actorKind: 'user',
            actorUserId: admin,
            actorRole: 'admin',
            targetType: 'user',
            targetId: String(target),
            requestId: actor.requestId,
            changes: { role: { from: 'user', to: 'kb_editor' } },
            // feat-247: the step-up proof of the admin's session.
            metadata: { proof: 'recent_sign_in' },
        })
        expect(auditLogLines(actor.logger)).toHaveLength(1)
        expect(announceRoleChanged).toHaveBeenCalledWith(target)
    })

    it('changes nothing and writes no event for the same role', async () => {
        const admin = await insertUser('admin')
        const target = await insertUser('kb_editor')
        const [before] = await db
            .select({ updatedAt: users.updatedAt })
            .from(users)
            .where(eq(users.id, target))

        const result = await assign({
            actor: actorFor(admin, 'admin'),
            targetUserId: target,
            role: 'kb_editor',
        })

        expect(result.isOk() && result.value.changed).toBe(false)
        const [after] = await db
            .select({ updatedAt: users.updatedAt })
            .from(users)
            .where(eq(users.id, target))
        expect(after?.updatedAt).toEqual(before?.updatedAt)
        expect(await eventsFor(target)).toHaveLength(0)
        expect(announceRoleChanged).not.toHaveBeenCalled()
    })

    it('rolls the role back when the event cannot be written', async () => {
        const admin = await insertUser('admin')
        const target = await insertEnrolled('user')
        vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit down'))

        await expect(
            assign({
                actor: actorFor(admin, 'admin'),
                targetUserId: target,
                role: 'support_operator',
            }),
        ).rejects.toThrow('audit down')

        expect(await roleOf(target)).toBe('user')
        expect(await eventsFor(target)).toHaveLength(0)
        expect(announceRoleChanged).not.toHaveBeenCalled()
    })

    it('lets a user_admin move a user between the roles it manages', async () => {
        const userAdmin = await insertUser('user_admin')
        const target = await insertEnrolled('user')
        const actor = actorFor(userAdmin, 'user_admin')

        const raised = await assign({
            actor,
            targetUserId: target,
            role: 'support_operator',
        })
        expect(raised.isOk()).toBe(true)
        const moved = await assign({
            actor,
            targetUserId: target,
            role: 'kb_editor',
        })
        expect(moved.isOk()).toBe(true)
        expect(await roleOf(target)).toBe('kb_editor')
        const events = await eventsFor(target)
        expect(events.map((event) => event.actorRole)).toEqual(['user_admin', 'user_admin'])
    })

    it.each<[string, Role, Role]>([
        ['give admin', 'user', 'admin'],
        ['give user_admin', 'user', 'user_admin'],
        ['lower an admin', 'admin', 'user'],
        ['lower another user_admin', 'user_admin', 'user'],
    ])('refuses a user_admin to %s', async (_name, from, to) => {
        const userAdmin = await insertUser('user_admin')
        const target = await insertUser(from)

        const result = await assign({
            actor: actorFor(userAdmin, 'user_admin'),
            targetUserId: target,
            role: to,
        })

        expect(result.isErr()).toBe(true)
        expect(payloadOf(result)).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Access denied',
        })
        expect(await roleOf(target)).toBe(from)
        expect(await eventsFor(target)).toHaveLength(0)
    })

    it('refuses an actor its own role and a role without users.roles.assign', async () => {
        const admin = await insertUser('admin')
        const own = await assign({
            actor: actorFor(admin, 'admin'),
            targetUserId: admin,
            role: 'user',
        })
        expect(own.isErr() && payloadOf(own).code).toBe('forbidden')
        expect(await roleOf(admin)).toBe('admin')

        const operator = await insertUser('support_operator')
        const target = await insertUser('user')
        const byOperator = await assign({
            actor: actorFor(operator, 'support_operator'),
            targetUserId: target,
            role: 'kb_editor',
        })
        expect(byOperator.isErr() && payloadOf(byOperator).code).toBe('forbidden')
    })

    it('answers 404 for a user that does not exist', async () => {
        const admin = await insertUser('admin')
        const result = await assign({
            actor: actorFor(admin, 'admin'),
            targetUserId: uid(9_000_000_000_000),
            role: 'kb_editor',
        })
        expect(result.isErr() && payloadOf(result).code).toBe('not_found')
    })

    it.each([
        ['an admin', 'user'],
        ['the CLI', 'system'],
    ])('refuses %s a staff role for an unverified account', async (_name, kind) => {
        const admin = await insertUser('admin')
        const target = await insertUser('user', false)

        const result = await assign({
            actor: kind === 'system' ? systemActor('cli') : actorFor(admin, 'admin'),
            targetUserId: target,
            role: 'support_operator',
        })

        expect(result.isErr()).toBe(true)
        expect(payloadOf(result)).toMatchObject({
            status: 'error',
            code: 'conflict',
            reason: 'identity_unverified',
        })
        expect(await roleOf(target)).toBe('user')
    })

    it('records a CLI change as a system event with the cli source', async () => {
        const target = await insertEnrolled('user')

        const result = await assign({
            actor: systemActor('cli'),
            targetUserId: target,
            role: 'user_admin',
        })

        expect(result.isOk()).toBe(true)
        const [event] = await eventsFor(target)
        expect(event).toMatchObject({
            actorKind: 'system',
            actorUserId: null,
            actorRole: null,
            requestId: null,
            changes: { role: { from: 'user', to: 'user_admin' } },
            metadata: { source: 'cli' },
        })
    })

    // feat-247 (Р10): with MFA_REQUIRED_FOR_STAFF on, a staff role needs a second factor.
    describe('a staff role needs MFA (feat-247 S5)', () => {
        it.each([
            ['an admin', 'user'],
            ['the CLI', 'system'],
        ])('%s gets 409 mfa_not_enrolled for an account without a factor', async (_name, kind) => {
            const admin = await insertUser('admin')
            const target = await insertUser('user')

            const result = await assign({
                actor: kind === 'system' ? systemActor('cli') : actorFor(admin, 'admin'),
                targetUserId: target,
                role: 'kb_editor',
            })

            expect(payloadOf(result)).toMatchObject({
                status: 'error',
                code: 'conflict',
                reason: 'mfa_not_enrolled',
            })
            expect(await roleOf(target)).toBe('user')
            expect(await eventsFor(target)).toHaveLength(0)
            expect(announceRoleChanged).not.toHaveBeenCalled()

            await addFactor(target)
            const again = await assign({
                actor: kind === 'system' ? systemActor('cli') : actorFor(admin, 'admin'),
                targetUserId: target,
                role: 'kb_editor',
            })
            expect(again.isOk()).toBe(true)
            expect(await roleOf(target)).toBe('kb_editor')
        })

        it('reads the factors in the transaction: a factor removed before the change counts', async () => {
            const target = await insertEnrolled('user')
            await db.execute(sql`DELETE FROM totp_factors WHERE user_id = ${target}`)

            const result = await assign({
                actor: systemActor('cli'),
                targetUserId: target,
                role: 'support_operator',
            })
            expect(payloadOf(result)).toMatchObject({ reason: 'mfa_not_enrolled' })
        })

        it.each([
            ['an admin', 'user'],
            ['the CLI', 'system'],
        ])('%s may always lower a staff account without a factor to user', async (_name, kind) => {
            const admin = await insertUser('admin')
            const target = await insertUser('support_operator')

            const result = await assign({
                actor: kind === 'system' ? systemActor('cli') : actorFor(admin, 'admin'),
                targetUserId: target,
                role: 'user',
            })

            expect(result.isOk() && result.value.changed).toBe(true)
            expect(await roleOf(target)).toBe('user')
        })

        it('moves a staff account without a factor between staff roles only with one', async () => {
            const target = await insertUser('support_operator')
            const moved = await assign({
                actor: systemActor('cli'),
                targetUserId: target,
                role: 'kb_editor',
            })
            expect(payloadOf(moved)).toMatchObject({ reason: 'mfa_not_enrolled' })
            expect(await roleOf(target)).toBe('support_operator')
        })

        it('gives the role without a factor while MFA_REQUIRED_FOR_STAFF is off', async () => {
            mfaConfig.requiredForStaff = false
            const target = await insertUser('user')
            const result = await assign({
                actor: systemActor('cli'),
                targetUserId: target,
                role: 'kb_editor',
            })
            expect(result.isOk()).toBe(true)
            expect(await roleOf(target)).toBe('kb_editor')
        })
    })

    describe('races', () => {
        /** Runs `work` with every admin but `keep` lowered to user, then gives them back. */
        const withOnlyAdmins = async (keep: UserId[], work: () => Promise<void>) => {
            const others = await db
                .select({ id: users.id })
                .from(users)
                .where(and(eq(users.role, 'admin'), ne(users.id, keep[0] ?? uid(0))))
            const lowered = others.map((row) => row.id).filter((id) => !keep.includes(id))
            if (lowered.length > 0) {
                await db.update(users).set({ role: 'user' }).where(inArray(users.id, lowered))
            }
            try {
                await work()
            } finally {
                if (lowered.length > 0) {
                    await db.update(users).set({ role: 'admin' }).where(inArray(users.id, lowered))
                }
            }
        }

        it('of two parallel lowerings of the last two admins, exactly one succeeds', async () => {
            const first = await insertUser('admin')
            const second = await insertUser('admin')

            await withOnlyAdmins([first, second], async () => {
                // Without the advisory lock both would count two admins before either writes;
                // the first count waits (up to 500 ms) for a second one, which the lock never
                // lets happen before the first change commits.
                const countByRole = userRepository.countByRole.bind(userRepository)
                let counted = 0
                let release: () => void = () => undefined
                const secondCount = new Promise<void>((resolve) => {
                    release = resolve
                })
                vi.spyOn(userRepository, 'countByRole').mockImplementation(async (...args) => {
                    const total = await countByRole(...args)
                    counted += 1
                    if (counted >= 2) release()
                    await Promise.race([secondCount, new Promise((r) => setTimeout(r, 500))])
                    return total
                })
                const results = await Promise.all([
                    assign({
                        actor: systemActor('cli'),
                        targetUserId: first,
                        role: 'user',
                    }),
                    assign({
                        actor: systemActor('cli'),
                        targetUserId: second,
                        role: 'user',
                    }),
                ])

                expect(results.filter((result) => result.isOk())).toHaveLength(1)
                const refused = results.find((result) => result.isErr())
                expect(refused !== undefined && payloadOf(refused)).toMatchObject({
                    code: 'conflict',
                    reason: 'last_admin',
                })
                const roles = [await roleOf(first), await roleOf(second)]
                expect(roles.filter((role) => role === 'admin')).toHaveLength(1)
                const events = [...(await eventsFor(first)), ...(await eventsFor(second))]
                expect(events).toHaveLength(1)
            })
        })

        // Review of feat-247, item 4: the actor's session is checked again at the write.
        it('refuses an actor whose session token rotated while its change waited: 401', async () => {
            const admin = await insertUser('admin')
            const target = await insertEnrolled('user')
            const presented = await tokenOf(admin)

            let assigned: ReturnType<typeof roleAssignmentService.assign> | undefined
            await db.transaction(async (tx) => {
                await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtextextended('user_role_change', 0))`,
                )
                assigned = roleAssignmentService.assign({
                    actor: actorFor(admin, 'admin'),
                    targetUserId: target,
                    role: 'kb_editor',
                    sessionAuth: freshAuth(),
                    presentedSessionToken: presented,
                    sessionStored: () => Promise.resolve(true),
                })
                await new Promise((resolve) => setTimeout(resolve, 300))
                // Logout everywhere of the admin meanwhile.
                await tx
                    .update(users)
                    .set({ sessionToken: 'rotated-admin-token' })
                    .where(eq(users.id, admin))
            })

            if (assigned === undefined) throw new Error('the change never started')
            const result = await assigned
            expect(payloadOf(result)).toMatchObject({
                code: 'unauthorized',
                reason: 'session_revoked',
            })
            expect(await roleOf(target)).toBe('user')
            expect(await eventsFor(target)).toHaveLength(0)
        })

        it('refuses an actor lowered while its change waited for the lock', async () => {
            const userAdmin = await insertUser('user_admin')
            const target = await insertUser('user')

            let assigned: ReturnType<typeof roleAssignmentService.assign> | undefined
            await db.transaction(async (tx) => {
                // Another role change holds the lock and lowers the actor meanwhile.
                await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtextextended('user_role_change', 0))`,
                )
                assigned = assign({
                    actor: actorFor(userAdmin, 'user_admin'),
                    targetUserId: target,
                    role: 'kb_editor',
                })
                await new Promise((resolve) => setTimeout(resolve, 300))
                await tx.update(users).set({ role: 'user' }).where(eq(users.id, userAdmin))
            })

            if (assigned === undefined) throw new Error('the change never started')
            const result = await assigned
            expect(result.isErr() && payloadOf(result).code).toBe('forbidden')
            expect(await roleOf(target)).toBe('user')
            expect(await eventsFor(target)).toHaveLength(0)
        })
    })
})
