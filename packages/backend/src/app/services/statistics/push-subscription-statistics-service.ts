import {
    pushNotificationLogRepository,
    pushSubscriptionRepository,
} from '#app/repositories/index.js'
import { pushSubscriptionTransformer } from '#app/transformers/index.js'
import type { SerializedPushSubscription } from '#app/transformers/push-subscription-transformer.js'

export interface PushSubscriptionStatistics {
    totalNotifications: number
    sentNotifications: number
    failedNotifications: number
    pendingNotifications: number
    successRate: number
    last7DaysCount: number
    /** ISO strings: the wire shape (feat-047). */
    lastUsed: string | null
    isActive: boolean
    createdAt: string
}

export interface PushSubscriptionStatisticsResult {
    subscription: SerializedPushSubscription
    statistics: PushSubscriptionStatistics
}

export async function getPushSubscriptionStatistics(
    subscriptionId: bigint,
    userId: bigint,
): Promise<PushSubscriptionStatisticsResult | undefined> {
    const subscription = await pushSubscriptionRepository.findByIdAndUserId(subscriptionId, userId)
    if (subscription === undefined) {
        return undefined
    }

    // The 7-day boundary comes from the app clock, as before, not from now() in SQL.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const counts = await pushNotificationLogRepository.countsBySubscription(
        subscriptionId,
        userId,
        sevenDaysAgo,
    )
    const totalNotifications = counts.total
    const sentNotifications = counts.sent
    const failedNotifications = counts.failed
    const pendingNotifications = counts.pending
    const last7DaysCount = counts.since

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
            lastUsed: subscription.lastUsedAt?.toISOString() ?? null,
            isActive: subscription.isActive,
            createdAt: subscription.createdAt.toISOString(),
        },
    }
}
