import { eq, inArray } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import type { NotificationId, UserId } from '#app/domain/ids.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-236 (Р1, Р4, Р6): the notification and preference repositories on a real PostgreSQL.
describe.skipIf(!hasPg)('notification repositories on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, notifications, notificationPreferences } = await import('#database/schema.js')
    const { notificationRepository, notificationPreferenceRepository } =
        await import('#app/repositories/index.js')

    const created: UserId[] = []
    const newUser = async (): Promise<UserId> => {
        const [row] = await db
            .insert(users)
            .values({ name: 'notifications-test', email: `${crypto.randomUUID()}@example.test` })
            .returning({ id: users.id })
        if (row === undefined) throw new Error('user not inserted')
        created.push(row.id)
        return row.id
    }
    const add = (userId: UserId, link: string | null = '/account') =>
        notificationRepository.insert({
            userId,
            category: 'security',
            kind: 'security.logout_all',
            params: {},
            link,
        })
    const addMany = async (userId: UserId, count: number): Promise<NotificationId[]> => {
        const ids: NotificationId[] = []
        for (let i = 0; i < count; i++) ids.push(await add(userId))
        return ids
    }
    const readAtOf = async (id: NotificationId): Promise<Date | null | undefined> => {
        const [row] = await db
            .select({ readAt: notifications.readAt })
            .from(notifications)
            .where(eq(notifications.id, id))
        return row?.readAt
    }

    afterAll(async () => {
        if (created.length > 0) await db.delete(users).where(inArray(users.id, created))
        await pool.end()
    })

    it('pages newest first without gaps or repeats, and filters the unread', async () => {
        const user = await newUser()
        const ids = await addMany(user, 25)

        const seen: NotificationId[] = []
        let before: NotificationId | null = null
        let pages = 0
        for (;;) {
            const page = await notificationRepository.page(user, {
                unread: false,
                before,
                limit: 10,
            })
            seen.push(...page.rows.map((row) => row.id))
            pages++
            if (page.next === null) break
            before = page.next
        }
        expect(pages).toBe(3)
        expect(seen).toEqual([...ids].reverse())

        await notificationRepository.markRead(user, ids[24]!)
        const unread = await notificationRepository.page(user, {
            unread: true,
            before: null,
            limit: 50,
        })
        expect(unread.rows).toHaveLength(24)
        expect(unread.rows.every((row) => row.readAt === null)).toBe(true)
        expect(unread.next).toBeNull()
    })

    it('a page of exactly `limit` rows has no next page', async () => {
        const user = await newUser()
        await addMany(user, 10)
        const page = await notificationRepository.page(user, {
            unread: false,
            before: null,
            limit: 10,
        })
        expect(page.rows).toHaveLength(10)
        expect(page.next).toBeNull()
    })

    it('counts the unread up to the cap of 100', async () => {
        const user = await newUser()
        await db.insert(notifications).values(
            Array.from({ length: 150 }, () => ({
                userId: user,
                category: 'security',
                kind: 'security.logout_all',
                params: {},
                link: '/account',
            })),
        )
        expect(await notificationRepository.countUnread(user)).toBe(100)
        expect(await notificationRepository.countUnread(await newUser())).toBe(0)
    })

    it('markRead: own answers the link, a repeat keeps read_at, missing is null', async () => {
        const user = await newUser()
        const id = await add(user, '/account#sessions')

        expect(await notificationRepository.markRead(user, id)).toEqual({
            link: '/account#sessions',
        })
        const first = await readAtOf(id)
        expect(first).toBeInstanceOf(Date)
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(await notificationRepository.markRead(user, id)).toEqual({
            link: '/account#sessions',
        })
        expect(await readAtOf(id)).toEqual(first)

        expect(
            await notificationRepository.markRead(user, 9_000_000_000_000n as NotificationId),
        ).toBeNull()
        const withoutLink = await add(user, null)
        expect(await notificationRepository.markRead(user, withoutLink)).toEqual({ link: null })
    })

    it("markRead of another user's notification answers null and leaves it unread", async () => {
        const owner = await newUser()
        const other = await newUser()
        const id = await add(owner)

        expect(await notificationRepository.markRead(other, id)).toBeNull()
        // Not only the answer: the row itself must stay unread (a user_id kept only in the SELECT
        // would still answer null).
        expect(await readAtOf(id)).toBeNull()
        expect(await notificationRepository.countUnread(owner)).toBe(1)
    })

    it('markAllUpTo marks every id <= upTo, older pages too, and none above', async () => {
        const user = await newUser()
        const other = await newUser()
        const ids = await addMany(user, 15)
        const foreign = await add(other)
        const upTo = ids[11]!

        expect(await notificationRepository.markAllUpTo(user, upTo)).toBe(12)
        for (const id of ids.slice(0, 12)) expect(await readAtOf(id)).toBeInstanceOf(Date)
        for (const id of ids.slice(12)) expect(await readAtOf(id)).toBeNull()
        expect(await readAtOf(foreign)).toBeNull()
        expect(await notificationRepository.countUnread(user)).toBe(3)
    })

    it('preferences: an upsert twice keeps one row with the last value', async () => {
        const user = await newUser()
        expect(await notificationPreferenceRepository.findByUserId(user)).toEqual([])

        await notificationPreferenceRepository.upsert(user, 'support', 'push', false)
        await notificationPreferenceRepository.upsert(user, 'support', 'push', true)

        expect(await notificationPreferenceRepository.findByUserId(user)).toEqual([
            { category: 'support', channel: 'push', enabled: true },
        ])
    })

    it.each([
        ['an unknown kind', { kind: 'security.unknown' }],
        ['an unknown category', { category: 'system' }],
        ['a link without a leading slash', { link: 'account' }],
    ])('refuses %s', async (_label, override) => {
        const user = await newUser()
        await expect(
            db.insert(notifications).values({
                userId: user,
                category: 'security',
                kind: 'security.logout_all',
                params: {},
                link: '/account',
                ...override,
            }),
        ).rejects.toThrow()
    })

    it('refuses an unknown channel of a preference', async () => {
        const user = await newUser()
        await expect(
            notificationPreferenceRepository.upsert(user, 'support', 'sms', true),
        ).rejects.toThrow()
    })

    it('deleting the user deletes their notifications and preferences', async () => {
        const user = await newUser()
        await add(user)
        await notificationPreferenceRepository.upsert(user, 'support', 'push', false)

        await db.delete(users).where(eq(users.id, user))

        expect(
            await db.select().from(notifications).where(eq(notifications.userId, user)),
        ).toHaveLength(0)
        expect(
            await db
                .select()
                .from(notificationPreferences)
                .where(eq(notificationPreferences.userId, user)),
        ).toHaveLength(0)
    })
})
