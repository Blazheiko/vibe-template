import { eq, inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { ROLES, STAFF_ROLES } from 'shared/access'

import { hasPg } from '../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const CHECK = 'users_staff_role_verified_email'

/** The constraint a failed query names, through the Drizzle wrapper. */
const violatedConstraint = (err: unknown): string | undefined => {
    const cause = (err as { cause?: { constraint?: string } }).cause
    return cause?.constraint ?? (err as { constraint?: string }).constraint
}

// feat-240 (Р3): the roles of the catalog are the values of user_role, and a staff role needs a
// verified email whatever path writes it.
describe.skipIf(!hasPg)('schema: users.role and users_staff_role_verified_email', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users } = await import('#database/schema.js')
    const stamp = String(Date.now())
    const ids: bigint[] = []
    let counter = 0

    const insert = async (role: (typeof ROLES)[number], verified: boolean) => {
        counter += 1
        const [row] = await db
            .insert(users)
            .values({
                name: `role-schema-${String(counter)}`,
                email: `role-schema-${String(counter)}-${stamp}@example.test`,
                emailVerifiedAt: verified ? new Date() : null,
                role,
            })
            .returning({ id: users.id, role: users.role })
        if (row === undefined) throw new Error('user not inserted')
        ids.push(row.id)
        return row
    }

    afterAll(async () => {
        if (ids.length > 0) await db.delete(users).where(inArray(users.id, ids))
        await pool.end()
    })

    it.each(ROLES)('stores the role %s on a verified account', async (role) => {
        const row = await insert(role, true)
        expect(row.role).toBe(role)
    })

    it('stores the user role on an unverified account', async () => {
        const row = await insert('user', false)
        expect(row.role).toBe('user')
    })

    it.each(STAFF_ROLES)('refuses to insert %s on an unverified account', async (role) => {
        const error = await insert(role, false).then(
            () => null,
            (err: unknown) => err,
        )
        expect(violatedConstraint(error)).toBe(CHECK)
    })

    it.each(STAFF_ROLES)('refuses to raise an unverified account to %s', async (role) => {
        const row = await insert('user', false)
        const error = await db
            .update(users)
            .set({ role })
            .where(eq(users.id, row.id))
            .then(
                () => null,
                (err: unknown) => err,
            )
        expect(violatedConstraint(error)).toBe(CHECK)
    })

    it('refuses to drop the verification of a staff account', async () => {
        const row = await insert('kb_editor', true)
        const error = await db
            .update(users)
            .set({ emailVerifiedAt: null })
            .where(eq(users.id, row.id))
            .then(
                () => null,
                (err: unknown) => err,
            )
        expect(violatedConstraint(error)).toBe(CHECK)
    })
})
