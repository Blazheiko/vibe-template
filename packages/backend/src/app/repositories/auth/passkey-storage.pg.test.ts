import { eq } from 'drizzle-orm'
import type { NormalizedEmail } from '#app/domain/email.js'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import type { PasskeyId, UserId } from '#app/domain/ids.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6, Р9, tasks P1): the passkeys as the migration
// created them, the counter that only grows and the WebAuthn user handle.
describe.skipIf(!hasPg)('passkey storage on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, webauthnCredentials, notifications } = await import('#database/schema.js')
    const { webauthnCredentialRepository: repo } = await import('#app/repositories/index.js')
    const { withTransaction } = await import('#app/repositories/transaction.js')

    const created: UserId[] = []
    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })

    const newUser = async (): Promise<UserId> => {
        const [user] = await db
            .insert(users)
            .values({
                name: 'passkey-storage',
                email: `${crypto.randomUUID()}@example.test` as NormalizedEmail,
            })
            .returning({ id: users.id })
        if (user === undefined) throw new Error('user not inserted')
        created.push(user.id)
        return user.id
    }

    const key = (userId: UserId, signCount = 0n) => ({
        userId,
        credentialId: Buffer.from(crypto.randomUUID()),
        publicKey: Buffer.from([1, 2, 3]),
        signCount,
        transports: ['internal', 'hybrid'],
        aaguid: null,
        deviceType: 'multiDevice',
        backedUp: true,
        name: 'Laptop',
        enrollmentId: crypto.randomUUID().replaceAll('-', ''),
    })

    it('stores a key with its bytes, transports and enrollment; lists and counts them', async () => {
        const userId = await newUser()
        const input = key(userId)
        const row = await withTransaction((tx) => repo.insert(input, tx))
        expect(row.credentialId.equals(input.credentialId)).toBe(true)
        expect(row.transports).toEqual(['internal', 'hybrid'])
        expect(await repo.countByUserId(userId)).toBe(1)
        expect((await repo.findByCredentialId(input.credentialId))?.id).toBe(row.id)
        expect((await repo.findByEnrollment(userId, input.enrollmentId))?.id).toBe(row.id)
        expect(await repo.findByEnrollment(userId, 'other')).toBeUndefined()
        expect((await repo.listByUserId(userId)).map((item) => item.id)).toEqual([row.id])
    })

    it('a credential id and an enrollment id are unique across all users', async () => {
        const [a, b] = [await newUser(), await newUser()]
        const first = key(a)
        await withTransaction((tx) => repo.insert(first, tx))
        await expect(
            withTransaction((tx) =>
                repo.insert({ ...key(b), credentialId: first.credentialId }, tx),
            ),
        ).rejects.toThrow()
        await expect(
            withTransaction((tx) =>
                repo.insert({ ...key(b), enrollmentId: first.enrollmentId }, tx),
            ),
        ).rejects.toThrow()
    })

    it('the counter: 0 and 0 is fine, otherwise it only grows; a regression is told', async () => {
        const userId = await newUser()
        const zero = await withTransaction((tx) => repo.insert(key(userId, 0n), tx))
        expect(await repo.recordUse(zero.id, 0n)).toBe('advanced')
        expect(await repo.recordUse(zero.id, 5n)).toBe('advanced')
        expect(await repo.recordUse(zero.id, 5n)).toBe('regressed')
        expect(await repo.recordUse(zero.id, 4n)).toBe('regressed')
        expect(await repo.recordUse(zero.id, 0n)).toBe('regressed')
        expect(await repo.recordUse(zero.id, 6n)).toBe('advanced')
        const [stored] = await db
            .select()
            .from(webauthnCredentials)
            .where(eq(webauthnCredentials.id, zero.id))
        expect(stored?.signCount).toBe(6n)
        expect(stored?.lastUsedAt).not.toBeNull()
        expect(await repo.recordUse(-1n as PasskeyId, 1n)).toBe('gone')
    })

    it('the user handle is made once; a second candidate keeps the first', async () => {
        const userId = await newUser()
        expect(await repo.userHandleOf(userId)).toBeNull()
        const first = Buffer.alloc(32, 1)
        const second = Buffer.alloc(32, 2)
        expect(
            (await withTransaction((tx) => repo.ensureUserHandle(userId, first, tx))).equals(first),
        ).toBe(true)
        expect(
            (await withTransaction((tx) => repo.ensureUserHandle(userId, second, tx))).equals(
                first,
            ),
        ).toBe(true)
    })

    it('rename and delete touch only a key of that user', async () => {
        const [owner, other] = [await newUser(), await newUser()]
        const row = await withTransaction((tx) => repo.insert(key(owner), tx))
        expect(await repo.rename(other, row.id, 'Stolen')).toBe(false)
        expect(await repo.rename(owner, row.id, 'Phone')).toBe(true)
        expect(await withTransaction((tx) => repo.deleteOne(other, row.id, tx))).toBe(false)
        expect(await withTransaction((tx) => repo.deleteOne(owner, row.id, tx))).toBe(true)
        expect(await repo.countByUserId(owner)).toBe(0)
    })

    it('deleteAllOfUser removes the keys and the handle; deleting the user cascades', async () => {
        const userId = await newUser()
        await withTransaction(async (tx) => {
            await repo.ensureUserHandle(userId, Buffer.alloc(32, 3), tx)
            await repo.insert(key(userId), tx)
            await repo.insert(key(userId), tx)
        })
        expect(await withTransaction((tx) => repo.deleteAllOfUser(userId, tx))).toBe(2)
        expect(await repo.userHandleOf(userId)).toBeNull()

        const cascaded = await newUser()
        await withTransaction((tx) => repo.insert(key(cascaded), tx))
        await db.delete(users).where(eq(users.id, cascaded))
        expect(await repo.countByUserId(cascaded)).toBe(0)
    })

    it('the notification kinds of the passkeys pass the CHECK constraint', async () => {
        const userId = await newUser()
        for (const kind of ['security.passkey_added', 'security.passkey_removed'] as const) {
            await db.insert(notifications).values({ userId, category: 'security', kind })
        }
        const rows = await db.select().from(notifications).where(eq(notifications.userId, userId))
        expect(rows).toHaveLength(2)
    })
})
