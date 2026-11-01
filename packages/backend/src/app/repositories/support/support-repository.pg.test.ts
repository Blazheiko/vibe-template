import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// A user message is stored once per client message id: a resend after a lost answer carries
// the same id and must not add a second row, even when it races the original.
describe.skipIf(!hasPg)('supportRepository.addUserMessageOnce on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, supportChatHistory } = await import('#database/schema.js')
    const { supportRepository } = await import('#app/repositories/index.js')

    const created: bigint[] = []
    const newUser = async (): Promise<bigint> => {
        const [row] = await db
            .insert(users)
            .values({ name: 'support-test', email: `${crypto.randomUUID()}@example.test` })
            .returning({ id: users.id })
        if (row === undefined) throw new Error('user not inserted')
        created.push(row.id)
        return row.id
    }
    const rowsOf = (userId: bigint) =>
        db.select().from(supportChatHistory).where(eq(supportChatHistory.userId, userId))

    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })

    it('stores a message with an id once, and says the second attempt was a duplicate', async () => {
        const user = await newUser()

        const first = await supportRepository.addUserMessageOnce(user, 'hello', 'id-1')
        const second = await supportRepository.addUserMessageOnce(user, 'hello', 'id-1')

        expect(first).toEqual({ stored: true })
        expect(second).toEqual({ stored: false })
        const rows = await rowsOf(user)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.clientMessageId).toBe('id-1')
    })

    it('is decided by the id, not by the text', async () => {
        const user = await newUser()

        await supportRepository.addUserMessageOnce(user, 'same text', 'id-a')
        const again = await supportRepository.addUserMessageOnce(user, 'same text', 'id-b')
        const reworded = await supportRepository.addUserMessageOnce(user, 'other text', 'id-a')

        expect(again).toEqual({ stored: true })
        expect(reworded).toEqual({ stored: false })
        expect(await rowsOf(user)).toHaveLength(2)
    })

    it('lets two users use the same id', async () => {
        const [a, b] = [await newUser(), await newUser()]

        const first = await supportRepository.addUserMessageOnce(a, 'hi', 'shared-id')
        const second = await supportRepository.addUserMessageOnce(b, 'hi', 'shared-id')

        expect(first).toEqual({ stored: true })
        expect(second).toEqual({ stored: true })
    })

    it('stores a message without an id every time', async () => {
        const user = await newUser()

        await supportRepository.addUserMessageOnce(user, 'one', undefined)
        await supportRepository.addUserMessageOnce(user, 'one', undefined)

        expect(await rowsOf(user)).toHaveLength(2)
    })

    it('stores 10 concurrent attempts with one id exactly once', async () => {
        const user = await newUser()

        const results = await Promise.all(
            Array.from({ length: 10 }, () =>
                supportRepository.addUserMessageOnce(user, 'race', 'id-race'),
            ),
        )

        expect(results.filter((r) => r.stored)).toHaveLength(1)
        expect(await rowsOf(user)).toHaveLength(1)
    })
})
