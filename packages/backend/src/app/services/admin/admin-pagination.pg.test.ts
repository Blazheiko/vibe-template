import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('#vendor/utils/logger.js', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-155 (review 2026-11-10, M4): the admin lists page by "one row more than the page". The
// repository clamped the query to 100 rows, so a page of 100 never saw its 101st row: no next
// page, and everything older than the newest 100 was out of reach.
describe.skipIf(!hasPg)('admin list pagination on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { userOnline, users } = await import('#database/schema.js')
    const { adminOnlineHistoryService } = await import('./admin-online-history-service.js')
    const { adminUserService } = await import('./admin-user-service.js')

    const stamp = String(Date.now())
    const created: bigint[] = []

    const insertUsers = async (count: number, tag: string): Promise<bigint[]> => {
        const rows = await db
            .insert(users)
            .values(
                Array.from({ length: count }, (_, n) => ({
                    name: `${tag} ${String(n)}`,
                    email: `${tag}-${String(n)}-${stamp}@example.test`,
                })),
            )
            .returning({ id: users.id })
        const ids = rows.map((row) => row.id)
        created.push(...ids)
        return ids
    }

    const insertConnections = async (userId: bigint, count: number): Promise<void> => {
        if (count === 0) return
        await db.insert(userOnline).values(
            Array.from({ length: count }, (_, n) => ({
                userId,
                socketUuid: `${String(userId)}-${String(n)}-${stamp}`,
                connectedAt: new Date(Date.now() - n * 1000),
            })),
        )
    }

    afterAll(async () => {
        if (created.length > 0) await db.delete(users).where(inArray(users.id, created))
        await pool.end()
    })

    describe('online history, a page of 100', () => {
        const owners = { rows99: 0n, rows100: 0n, rows101: 0n }

        beforeAll(async () => {
            const [a, b, c] = await insertUsers(3, 'history')
            owners.rows99 = a ?? 0n
            owners.rows100 = b ?? 0n
            owners.rows101 = c ?? 0n
            await insertConnections(owners.rows99, 99)
            await insertConnections(owners.rows100, 100)
            await insertConnections(owners.rows101, 101)
        })

        it('99 rows: one page, nothing more', async () => {
            const page = await adminOnlineHistoryService.listHistory({
                userId: owners.rows99,
                limit: 100,
            })
            expect(page.items).toHaveLength(99)
            expect(page).toMatchObject({ total: 99, hasMore: false, nextCursor: null })
        })

        it('100 rows: one full page, nothing more', async () => {
            const page = await adminOnlineHistoryService.listHistory({
                userId: owners.rows100,
                limit: 100,
            })
            expect(page.items).toHaveLength(100)
            expect(page).toMatchObject({ total: 100, hasMore: false, nextCursor: null })
        })

        it('101 rows: a full page with a cursor, and the second page holds the last row', async () => {
            const first = await adminOnlineHistoryService.listHistory({
                userId: owners.rows101,
                limit: 100,
            })
            expect(first.items).toHaveLength(100)
            expect(first).toMatchObject({ total: 101, hasMore: true })
            expect(first.nextCursor).toBe(first.items.at(-1)?.id)

            const second = await adminOnlineHistoryService.listHistory({
                userId: owners.rows101,
                limit: 100,
                cursor: BigInt(first.nextCursor ?? '0'),
            })
            expect(second.items).toHaveLength(1)
            expect(second).toMatchObject({ total: 101, hasMore: false, nextCursor: null })
            const seen = new Set([...first.items, ...second.items].map((item) => item.id))
            expect(seen.size).toBe(101)
        })

        it('serves the largest page the query schema allows (200) the same way', async () => {
            const page = await adminOnlineHistoryService.listHistory({
                userId: owners.rows101,
                limit: 200,
            })
            expect(page.items).toHaveLength(101)
            expect(page).toMatchObject({ limit: 200, hasMore: false, nextCursor: null })
        })
    })

    describe('admin users', () => {
        // Its own window in time, so other users of the test database stay out of the page.
        const dateFrom = new Date('2001-03-04T00:00:00.000Z')
        const window = { dateFrom, dateTo: dateFrom }

        beforeAll(async () => {
            const ids = await insertUsers(101, 'paged')
            await db
                .update(users)
                .set({ createdAt: new Date('2001-03-04T12:00:00.000Z') })
                .where(inArray(users.id, ids))
        })

        it('reaches the 101st user through the cursor of the first page', async () => {
            const first = await adminUserService.listUsers({ ...window, limit: 100 })
            expect(first.items).toHaveLength(100)
            expect(first).toMatchObject({ total: 101, hasMore: true })
            expect(first.nextCursor).toBe(first.items.at(-1)?.id)

            const second = await adminUserService.listUsers({
                ...window,
                limit: 100,
                cursor: BigInt(first.nextCursor ?? '0'),
            })
            expect(second.items).toHaveLength(1)
            expect(second).toMatchObject({ total: 101, hasMore: false, nextCursor: null })
            const seen = new Set([...first.items, ...second.items].map((item) => item.id))
            expect(seen.size).toBe(101)
        })

        it('a page that holds everything has no cursor', async () => {
            const page = await adminUserService.listUsers({ ...window, limit: 200 })
            expect(page.items).toHaveLength(101)
            expect(page).toMatchObject({ total: 101, hasMore: false, nextCursor: null })
        })
    })
})
