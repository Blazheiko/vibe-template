import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-022 (code-issues items 20, 21): the push data paths keep their results
// while dropping the N+1 and the JS aggregation. The legacy implementations are
// copied here verbatim as the reference.
describe.skipIf(!hasPg)('push data access on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { pushNotificationLogs, pushSubscriptions, users } = await import('#database/schema.js')
    const { pushNotificationLogRepository, pushSubscriptionRepository } =
        await import('#app/repositories/index.js')
    const { getPushSubscriptionStatistics } =
        await import('#app/services/statistics/push-subscription-statistics-service.js')
    const { pushSubscriptionTransformer } = await import('#app/transformers/index.js')

    const DAY = 24 * 60 * 60 * 1000
    const now = Date.now()
    const ids = { userA: 0n, userB: 0n, userEmpty: 0n, s1: 0n, s2: 0n, s3: 0n, sB: 0n }

    const legacyFindByUserIdWithLogs = async (userId: bigint) => {
        const subscriptionsData = await db
            .select()
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, userId))
            .orderBy(desc(pushSubscriptions.createdAt))
        return Promise.all(
            subscriptionsData.map(async (sub) => {
                const logs = await db
                    .select({
                        id: pushNotificationLogs.id,
                        messageTitle: pushNotificationLogs.messageTitle,
                        status: pushNotificationLogs.status,
                        sentAt: pushNotificationLogs.sentAt,
                    })
                    .from(pushNotificationLogs)
                    .where(eq(pushNotificationLogs.subscriptionId, sub.id))
                    .orderBy(desc(pushNotificationLogs.sentAt))
                    .limit(5)
                return { ...sub, notificationLogs: logs }
            }),
        )
    }

    const legacyStatistics = async (subscriptionId: bigint, userId: bigint) => {
        const subscription = await pushSubscriptionRepository.findByIdAndUserId(
            subscriptionId,
            userId,
        )
        if (subscription === undefined) return undefined
        const logs = await db
            .select()
            .from(pushNotificationLogs)
            .where(eq(pushNotificationLogs.subscriptionId, subscriptionId))
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        const totalNotifications = logs.length
        const sentNotifications = logs.filter((l) => l.status === 'SENT').length
        const failedNotifications = logs.filter((l) => l.status === 'FAILED').length
        const pendingNotifications = logs.filter((l) => l.status === 'PENDING').length
        const last7DaysCount = logs.filter((l) => l.sentAt >= sevenDaysAgo).length
        return {
            subscription: pushSubscriptionTransformer.serialize(subscription),
            statistics: {
                totalNotifications,
                sentNotifications,
                failedNotifications,
                pendingNotifications,
                successRate:
                    totalNotifications > 0 ? (sentNotifications / totalNotifications) * 100 : 0,
                last7DaysCount,
                // Wire shape since feat-047: ISO strings.
                lastUsed: subscription.lastUsedAt?.toISOString() ?? null,
                isActive: subscription.isActive,
                createdAt: subscription.createdAt.toISOString(),
            },
        }
    }

    const countQueries = async <T>(
        run: () => Promise<T>,
    ): Promise<{ result: T; queries: number }> => {
        const spy = vi.spyOn(pool, 'query')
        try {
            const result = await run()
            return { result, queries: spy.mock.calls.length }
        } finally {
            spy.mockRestore()
        }
    }

    const insertUser = async (name: string): Promise<bigint> => {
        const [row] = await db
            .insert(users)
            .values({ name, email: `${name}-${String(now)}@example.test` })
            .returning({ id: users.id })
        if (row === undefined) throw new Error('user not inserted')
        return row.id
    }

    const insertSubscription = async (userId: bigint, tag: string, ageDays: number) => {
        const [row] = await db
            .insert(pushSubscriptions)
            .values({
                userId,
                endpoint: `https://push.example.test/${tag}-${String(now)}`,
                p256dhKey: `p-${tag}`,
                authKey: `a-${tag}`,
                createdAt: new Date(now - ageDays * DAY),
                lastUsedAt: new Date(now - ageDays * DAY + 1000),
            })
            .returning({ id: pushSubscriptions.id })
        if (row === undefined) throw new Error('subscription not inserted')
        return row.id
    }

    type Status = 'SENT' | 'FAILED' | 'PENDING' | null
    const insertLogs = async (
        userId: bigint,
        subscriptionId: bigint,
        logs: { status: Status; ageDays: number }[],
    ) => {
        await db.insert(pushNotificationLogs).values(
            logs.map((log, index) => ({
                userId,
                subscriptionId,
                messageTitle: `title ${String(index)}`,
                messageBody: 'body',
                status: log.status,
                sentAt: new Date(now - log.ageDays * DAY - index * 1000),
            })),
        )
    }

    beforeAll(async () => {
        ids.userA = await insertUser('push-a')
        ids.userB = await insertUser('push-b')
        ids.userEmpty = await insertUser('push-empty')
        ids.s1 = await insertSubscription(ids.userA, 's1', 3)
        ids.s2 = await insertSubscription(ids.userA, 's2', 2)
        ids.s3 = await insertSubscription(ids.userA, 's3', 1)
        ids.sB = await insertSubscription(ids.userB, 'sB', 1)
        // s1: 7 logs, mixed statuses incl. NULL, some older than 7 days.
        await insertLogs(ids.userA, ids.s1, [
            { status: 'SENT', ageDays: 0.1 },
            { status: 'FAILED', ageDays: 1 },
            { status: 'SENT', ageDays: 2 },
            { status: 'PENDING', ageDays: 3 },
            { status: null, ageDays: 6 },
            { status: 'SENT', ageDays: 8 },
            { status: 'FAILED', ageDays: 30 },
        ])
        await insertLogs(ids.userA, ids.s2, [
            { status: 'SENT', ageDays: 0.5 },
            { status: 'SENT', ageDays: 10 },
        ])
        await insertLogs(ids.userB, ids.sB, [{ status: 'SENT', ageDays: 0.2 }])
    })

    afterAll(async () => {
        await db.delete(users).where(eq(users.id, ids.userA))
        await db.delete(users).where(eq(users.id, ids.userB))
        await db.delete(users).where(eq(users.id, ids.userEmpty))
        await pool.end()
    })

    describe('findByUserIdWithLogs', () => {
        it('returns the same result as the legacy implementation', async () => {
            const expected = await legacyFindByUserIdWithLogs(ids.userA)
            const actual = await pushSubscriptionRepository.findByUserIdWithLogs(ids.userA)
            expect(actual).toEqual(expected)
        })

        it('keeps the contract: order, at most 5 newest logs, [] without logs', async () => {
            const actual = await pushSubscriptionRepository.findByUserIdWithLogs(ids.userA)
            expect(actual.map((sub) => sub.id)).toEqual([ids.s3, ids.s2, ids.s1])
            const [s3, s2, s1] = actual
            expect(s3?.notificationLogs).toEqual([])
            expect(s2?.notificationLogs).toHaveLength(2)
            expect(s1?.notificationLogs).toHaveLength(5)
            const sentAt = s1?.notificationLogs.map((log) => log.sentAt.getTime()) ?? []
            expect(sentAt).toEqual([...sentAt].sort((a, b) => b - a))
            expect(Object.keys(s1?.notificationLogs[0] ?? {}).sort()).toEqual([
                'id',
                'messageTitle',
                'sentAt',
                'status',
            ])
        })

        it('uses 2 queries, and 1 for a user without subscriptions', async () => {
            const withSubs = await countQueries(() =>
                pushSubscriptionRepository.findByUserIdWithLogs(ids.userA),
            )
            expect(withSubs.queries).toBe(2)
            const empty = await countQueries(() =>
                pushSubscriptionRepository.findByUserIdWithLogs(ids.userEmpty),
            )
            expect(empty.result).toEqual([])
            expect(empty.queries).toBe(1)
        })
    })

    describe('getPushSubscriptionStatistics', () => {
        it.each([['s1'], ['s2'], ['s3']] as const)(
            'returns the same result as the legacy implementation for %s',
            async (key) => {
                const expected = await legacyStatistics(ids[key], ids.userA)
                const actual = await getPushSubscriptionStatistics(ids[key], ids.userA)
                expect(actual).toEqual(expected)
            },
        )

        it('counts s1 as expected', async () => {
            const actual = await getPushSubscriptionStatistics(ids.s1, ids.userA)
            expect(actual?.statistics).toMatchObject({
                totalNotifications: 7,
                sentNotifications: 3,
                failedNotifications: 2,
                pendingNotifications: 1,
                last7DaysCount: 5,
            })
            expect(actual?.statistics.successRate).toBeCloseTo((3 / 7) * 100)
        })

        it('stays undefined for a subscription of another user', async () => {
            expect(await getPushSubscriptionStatistics(ids.sB, ids.userA)).toBeUndefined()
        })

        it('aggregates in SQL instead of loading every log row', async () => {
            const spy = vi.spyOn(pool, 'query')
            try {
                await getPushSubscriptionStatistics(ids.s1, ids.userA)
                const sqlTexts = spy.mock.calls.map((call) => {
                    const first: unknown = call[0]
                    if (typeof first === 'string') return first
                    const text = (first as { text?: unknown }).text
                    return typeof text === 'string' ? text : ''
                })
                expect(sqlTexts).toHaveLength(2)
                expect(sqlTexts.some((text) => /count\(/i.test(text))).toBe(true)
                expect(sqlTexts.some((text) => text.includes('"message_body"'))).toBe(false)
            } finally {
                spy.mockRestore()
            }
        })
    })

    describe('push-notification-log-repository and touchLastUsed', () => {
        it('insertMany writes every row in one statement, and nothing for []', async () => {
            const { queries: none } = await countQueries(() =>
                pushNotificationLogRepository.insertMany([]),
            )
            expect(none).toBe(0)

            const { queries } = await countQueries(() =>
                pushNotificationLogRepository.insertMany([
                    {
                        userId: ids.userB,
                        subscriptionId: ids.sB,
                        status: 'SENT',
                        sentAt: new Date(),
                    },
                    {
                        userId: ids.userB,
                        subscriptionId: ids.sB,
                        status: 'FAILED',
                        sentAt: new Date(),
                    },
                ]),
            )
            expect(queries).toBe(1)
            const counts = await pushNotificationLogRepository.countsBySubscription(
                ids.sB,
                ids.userB,
                new Date(now - DAY),
            )
            expect(counts).toEqual({ total: 3, sent: 2, failed: 1, pending: 0, since: 3 })
        })

        it('latestBySubscriptionIds returns [] for no ids without a query', async () => {
            const { result, queries } = await countQueries(() =>
                pushNotificationLogRepository.latestBySubscriptionIds([], ids.userA, 5),
            )
            expect(result).toEqual([])
            expect(queries).toBe(0)
        })

        it('touchLastUsed updates only the given subscriptions of that user', async () => {
            const before = await pushSubscriptionRepository.findById(ids.s2)
            await pushSubscriptionRepository.touchLastUsed([ids.s1, ids.sB], ids.userA)
            const s1 = await pushSubscriptionRepository.findById(ids.s1)
            const s2 = await pushSubscriptionRepository.findById(ids.s2)
            const sB = await pushSubscriptionRepository.findById(ids.sB)
            expect(s1?.lastUsedAt?.getTime()).toBeGreaterThan(now - 60_000)
            expect(s2?.lastUsedAt).toEqual(before?.lastUsedAt)
            // sB belongs to user B: not touched by user A.
            expect(sB?.lastUsedAt?.getTime()).toBeLessThan(now - DAY / 2)
        })
    })

    // feat-147 (review 2026-11-10, M2): a subscription keeps its id when it moves to
    // another account (same browser, account switch), so every read of its log has to
    // be scoped by the log's owner too.
    describe('log of a subscription that moved to another account', () => {
        const moved = { userA: 0n, userB: 0n, subscription: 0n, endpoint: '' }

        const insertLog = async (userId: bigint, title: string, status: 'SENT' | 'FAILED') => {
            await db.insert(pushNotificationLogs).values({
                userId,
                subscriptionId: moved.subscription,
                messageTitle: title,
                messageBody: 'body',
                status,
                sentAt: new Date(),
            })
        }

        const moveTo = async (userId: bigint) => {
            const row = await pushSubscriptionRepository.updateByEndpoint(
                moved.endpoint,
                userId,
                {},
            )
            expect(row?.id).toBe(moved.subscription)
            expect(row?.userId).toBe(userId)
        }

        beforeAll(async () => {
            moved.userA = await insertUser('push-moved-a')
            moved.userB = await insertUser('push-moved-b')
            moved.subscription = await insertSubscription(moved.userA, 'moved', 1)
            moved.endpoint = `https://push.example.test/moved-${String(now)}`
            await insertLog(moved.userA, 'A: new sign-in', 'SENT')
            await insertLog(moved.userA, 'A: password changed', 'FAILED')
            await moveTo(moved.userB)
            await insertLog(moved.userB, 'B: test push', 'SENT')
        })

        afterAll(async () => {
            await db.delete(users).where(eq(users.id, moved.userA))
            await db.delete(users).where(eq(users.id, moved.userB))
        })

        it('the subscription list of the new owner has only their own log', async () => {
            const [subscription] = await pushSubscriptionRepository.findByUserIdWithLogs(
                moved.userB,
            )
            expect(subscription?.id).toBe(moved.subscription)
            expect(subscription?.notificationLogs.map((log) => log.messageTitle)).toEqual([
                'B: test push',
            ])
        })

        it('the statistics of the new owner count only their own sends', async () => {
            const result = await getPushSubscriptionStatistics(moved.subscription, moved.userB)
            expect(result?.statistics).toMatchObject({
                totalNotifications: 1,
                sentNotifications: 1,
                failedNotifications: 0,
                last7DaysCount: 1,
            })
        })

        it('the log of the subscription has only the rows of the new owner', async () => {
            const logs = await pushSubscriptionRepository.getLogsBySubscriptionId(
                moved.subscription,
                moved.userB,
            )
            expect(logs.map((log) => log.messageTitle)).toEqual(['B: test push'])
        })

        it('keeps the log of the previous owner: they see it again after a move back', async () => {
            await moveTo(moved.userA)
            const [subscription] = await pushSubscriptionRepository.findByUserIdWithLogs(
                moved.userA,
            )
            expect(subscription?.notificationLogs.map((log) => log.messageTitle).sort()).toEqual([
                'A: new sign-in',
                'A: password changed',
            ])
            const result = await getPushSubscriptionStatistics(moved.subscription, moved.userA)
            expect(result?.statistics).toMatchObject({
                totalNotifications: 2,
                sentNotifications: 1,
                failedNotifications: 1,
            })
        })
    })
})
