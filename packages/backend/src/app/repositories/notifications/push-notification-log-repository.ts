import { db } from '#database/db.js'
import { pushNotificationLogs } from '#database/schema.js'
import { and, count, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import type { InferInsertModel } from 'drizzle-orm'

import type { PushSubscriptionLogSummary } from './push-subscription-repository.js'

export type PushNotificationLogInsert = InferInsertModel<typeof pushNotificationLogs>

export interface PushNotificationLogCounts {
    total: number
    sent: number
    failed: number
    pending: number
    since: number
}

export type PushSubscriptionLogSummaryRow = PushSubscriptionLogSummary & {
    subscriptionId: bigint | null
}

export interface IPushNotificationLogRepository {
    insertMany(rows: PushNotificationLogInsert[]): Promise<void>
    // Both reads take the owner too: a subscription keeps its id when it moves to another
    // account, and the log rows of the previous owner stay theirs.
    countsBySubscription(
        subscriptionId: bigint,
        userId: bigint,
        since: Date,
    ): Promise<PushNotificationLogCounts>
    latestBySubscriptionIds(
        subscriptionIds: bigint[],
        userId: bigint,
        limit: number,
    ): Promise<PushSubscriptionLogSummaryRow[]>
}

export const pushNotificationLogRepository: IPushNotificationLogRepository = {
    async insertMany(rows) {
        if (rows.length === 0) return
        await db.insert(pushNotificationLogs).values(rows)
    },

    async countsBySubscription(subscriptionId, userId, since) {
        const [row] = await db
            .select({
                total: count(),
                sent: count(sql`case when ${pushNotificationLogs.status} = 'SENT' then 1 end`),
                failed: count(sql`case when ${pushNotificationLogs.status} = 'FAILED' then 1 end`),
                pending: count(
                    sql`case when ${pushNotificationLogs.status} = 'PENDING' then 1 end`,
                ),
                since: count(sql`case when ${gte(pushNotificationLogs.sentAt, since)} then 1 end`),
            })
            .from(pushNotificationLogs)
            .where(
                and(
                    eq(pushNotificationLogs.subscriptionId, subscriptionId),
                    eq(pushNotificationLogs.userId, userId),
                ),
            )
        return row ?? { total: 0, sent: 0, failed: 0, pending: 0, since: 0 }
    },

    // The newest `limit` logs of every subscription in one query.
    async latestBySubscriptionIds(subscriptionIds, userId, limit) {
        if (subscriptionIds.length === 0) return []
        const ranked = db
            .select({
                id: pushNotificationLogs.id,
                subscriptionId: pushNotificationLogs.subscriptionId,
                messageTitle: pushNotificationLogs.messageTitle,
                status: pushNotificationLogs.status,
                sentAt: pushNotificationLogs.sentAt,
                rank: sql<number>`row_number() over (partition by ${pushNotificationLogs.subscriptionId} order by ${pushNotificationLogs.sentAt} desc, ${pushNotificationLogs.id} desc)`.as(
                    'rank',
                ),
            })
            .from(pushNotificationLogs)
            .where(
                and(
                    inArray(pushNotificationLogs.subscriptionId, subscriptionIds),
                    eq(pushNotificationLogs.userId, userId),
                ),
            )
            .as('ranked')
        return await db
            .select({
                id: ranked.id,
                subscriptionId: ranked.subscriptionId,
                messageTitle: ranked.messageTitle,
                status: ranked.status,
                sentAt: ranked.sentAt,
            })
            .from(ranked)
            .where(sql`${ranked.rank} <= ${limit}`)
            .orderBy(ranked.subscriptionId, desc(ranked.sentAt), desc(ranked.id))
    },
}
