import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// A user message is stored once per client message id: a resend after a lost answer carries
// the same id and must not add a second row, even when it races the original.
describe.skipIf(!hasPg)('supportRepository.addUserMessageOnce on PostgreSQL', async () => {
    const { db } = await import('#database/db.js')
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

// feat-063, D3: the history is read in pages for the UI and as a bounded recent slice for the
// prompt; neither is an unbounded read, and both are ordered by id (createdAt can tie).
describe.skipIf(!hasPg)('supportRepository history reads on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users } = await import('#database/schema.js')
    const { supportRepository } = await import('#app/repositories/index.js')

    const created: bigint[] = []
    const newUser = async (): Promise<bigint> => {
        const [row] = await db
            .insert(users)
            .values({ name: 'history-test', email: `${crypto.randomUUID()}@example.test` })
            .returning({ id: users.id })
        if (row === undefined) throw new Error('user not inserted')
        created.push(row.id)
        return row.id
    }
    // Messages m1 … mN in order; returns their ids.
    const conversation = async (userId: bigint, count: number): Promise<bigint[]> => {
        const ids: bigint[] = []
        for (let i = 1; i <= count; i++) {
            const row = await supportRepository.addChatMessage(
                userId,
                i % 2 === 1 ? 'user' : 'assistant',
                `m${String(i)}`,
            )
            ids.push(row.id)
        }
        return ids
    }
    const contents = (rows: { content: string }[]): string[] => rows.map((r) => r.content)

    // The last suite of the file closes the pool the first one opened.
    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })

    describe('findChatHistoryPage', () => {
        it('returns the latest page oldest-first, and says there is more before it', async () => {
            const user = await newUser()
            await conversation(user, 7)

            const page = await supportRepository.findChatHistoryPage(user, { limit: 3 })

            expect(contents(page.rows)).toEqual(['m5', 'm6', 'm7'])
            expect(page.hasMore).toBe(true)
        })

        it('walks back page by page with the id of the oldest message it has', async () => {
            const user = await newUser()
            const ids = await conversation(user, 7)

            const first = await supportRepository.findChatHistoryPage(user, { limit: 3 })
            const second = await supportRepository.findChatHistoryPage(user, {
                limit: 3,
                before: first.rows[0]?.id,
            })
            const third = await supportRepository.findChatHistoryPage(user, {
                limit: 3,
                before: second.rows[0]?.id,
            })

            expect(contents(second.rows)).toEqual(['m2', 'm3', 'm4'])
            expect(second.hasMore).toBe(true)
            expect(contents(third.rows)).toEqual(['m1'])
            expect(third.hasMore).toBe(false)
            expect(third.rows[0]?.id).toBe(ids[0])
        })

        it('does not say there is more when the page is exactly the rest', async () => {
            const user = await newUser()
            await conversation(user, 3)

            const page = await supportRepository.findChatHistoryPage(user, { limit: 3 })

            expect(contents(page.rows)).toEqual(['m1', 'm2', 'm3'])
            expect(page.hasMore).toBe(false)
        })

        it('is empty for a user without messages', async () => {
            const user = await newUser()

            expect(await supportRepository.findChatHistoryPage(user, { limit: 50 })).toEqual({
                rows: [],
                hasMore: false,
            })
        })

        it('never returns another user’s messages, even with their cursor', async () => {
            const [mine, theirs] = [await newUser(), await newUser()]
            await conversation(mine, 2)
            const others = await conversation(theirs, 2)

            const page = await supportRepository.findChatHistoryPage(mine, {
                limit: 10,
                before: others[1],
            })

            expect(contents(page.rows)).toEqual(['m1', 'm2'])
            expect(page.rows.every((r) => r.userId === mine)).toBe(true)
        })

        // Several rows inserted in one millisecond have the same created_at: the id decides.
        it('keeps the insertion order for rows with the same timestamp', async () => {
            const user = await newUser()
            const at = new Date('2026-01-01T00:00:00.000Z')
            const { supportChatHistory } = await import('#database/schema.js')
            await db.insert(supportChatHistory).values([
                { userId: user, role: 'user', content: 'a', createdAt: at },
                { userId: user, role: 'assistant', content: 'b', createdAt: at },
                { userId: user, role: 'user', content: 'c', createdAt: at },
            ])

            const page = await supportRepository.findChatHistoryPage(user, { limit: 2 })

            expect(contents(page.rows)).toEqual(['b', 'c'])
        })
    })

    describe('findRecentForContext', () => {
        it('returns only the last N messages, oldest-first', async () => {
            const user = await newUser()
            await conversation(user, 30)

            const recent = await supportRepository.findRecentForContext(user, 20)

            expect(recent).toHaveLength(20)
            expect(recent[0]?.content).toBe('m11')
            expect(recent.at(-1)?.content).toBe('m30')
        })

        it('returns everything when there are fewer', async () => {
            const user = await newUser()
            await conversation(user, 3)

            expect(contents(await supportRepository.findRecentForContext(user, 20))).toEqual([
                'm1',
                'm2',
                'm3',
            ])
        })
    })

    describe('hasChatHistory', () => {
        it('tells whether the user has any message', async () => {
            const [empty, started] = [await newUser(), await newUser()]
            await conversation(started, 1)

            expect(await supportRepository.hasChatHistory(empty)).toBe(false)
            expect(await supportRepository.hasChatHistory(started)).toBe(true)
        })
    })
})
