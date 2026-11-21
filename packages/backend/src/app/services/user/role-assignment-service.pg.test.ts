import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import type { Role } from 'shared/access'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { auditLogLines, testAdminActor } from '../../../test-support/audit-actor.js'

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

describe.skipIf(!hasPg)('roleAssignmentService on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { auditEvents, users } = await import('#database/schema.js')
    const { auditService } = await import('#app/services/audit/audit-service.js')
    const { systemActor } = await import('#app/services/audit/audit-actor.js')
    const { appErrorToPayload } = await import('#app/services/shared/app-error-payload.js')
    const { roleAssignmentService } = await import('./role-assignment-service.js')
    const { userRepository } = await import('#app/repositories/index.js')

    const stamp = String(Date.now())
    const userIds: bigint[] = []
    let counter = 0

    const insertUser = async (role: Role, verified = true): Promise<bigint> => {
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

    const roleOf = async (id: bigint): Promise<Role | undefined> => {
        const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, id))
        return row?.role
    }

    const eventsFor = (targetUserId: bigint) =>
        db
            .select()
            .from(auditEvents)
            .where(
                and(
                    eq(auditEvents.targetUserId, targetUserId),
                    eq(auditEvents.action, 'user.role.changed'),
                ),
            )

    /** An actor as the HTTP layer builds it: the guard's role, a request of its own. */
    const actorFor = (userId: bigint, role: Role) => ({ ...testAdminActor(userId), role })

    const payloadOf = (result: { isErr(): boolean; error?: unknown }) =>
        appErrorToPayload(
            (result as unknown as { error: Parameters<typeof appErrorToPayload>[0] }).error,
        )

    afterEach(() => {
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

    it('changes the role and writes one event in the same transaction', async () => {
        const admin = await insertUser('admin')
        const target = await insertUser('user')
        const actor = actorFor(admin, 'admin')

        const result = await roleAssignmentService.assign({
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
            metadata: null,
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

        const result = await roleAssignmentService.assign({
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
        const target = await insertUser('user')
        vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit down'))

        await expect(
            roleAssignmentService.assign({
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
        const target = await insertUser('user')
        const actor = actorFor(userAdmin, 'user_admin')

        const raised = await roleAssignmentService.assign({
            actor,
            targetUserId: target,
            role: 'support_operator',
        })
        expect(raised.isOk()).toBe(true)
        const moved = await roleAssignmentService.assign({
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

        const result = await roleAssignmentService.assign({
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
        const own = await roleAssignmentService.assign({
            actor: actorFor(admin, 'admin'),
            targetUserId: admin,
            role: 'user',
        })
        expect(own.isErr() && payloadOf(own).code).toBe('forbidden')
        expect(await roleOf(admin)).toBe('admin')

        const operator = await insertUser('support_operator')
        const target = await insertUser('user')
        const byOperator = await roleAssignmentService.assign({
            actor: actorFor(operator, 'support_operator'),
            targetUserId: target,
            role: 'kb_editor',
        })
        expect(byOperator.isErr() && payloadOf(byOperator).code).toBe('forbidden')
    })

    it('answers 404 for a user that does not exist', async () => {
        const admin = await insertUser('admin')
        const result = await roleAssignmentService.assign({
            actor: actorFor(admin, 'admin'),
            targetUserId: 9_000_000_000_000n,
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

        const result = await roleAssignmentService.assign({
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
        const target = await insertUser('user')

        const result = await roleAssignmentService.assign({
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

    describe('races', () => {
        /** Runs `work` with every admin but `keep` lowered to user, then gives them back. */
        const withOnlyAdmins = async (keep: bigint[], work: () => Promise<void>) => {
            const others = await db
                .select({ id: users.id })
                .from(users)
                .where(and(eq(users.role, 'admin'), ne(users.id, keep[0] ?? 0n)))
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
                    roleAssignmentService.assign({
                        actor: systemActor('cli'),
                        targetUserId: first,
                        role: 'user',
                    }),
                    roleAssignmentService.assign({
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

        it('refuses an actor lowered while its change waited for the lock', async () => {
            const userAdmin = await insertUser('user_admin')
            const target = await insertUser('user')

            let assigned: ReturnType<typeof roleAssignmentService.assign> | undefined
            await db.transaction(async (tx) => {
                // Another role change holds the lock and lowers the actor meanwhile.
                await tx.execute(
                    sql`SELECT pg_advisory_xact_lock(hashtextextended('user_role_change', 0))`,
                )
                assigned = roleAssignmentService.assign({
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
