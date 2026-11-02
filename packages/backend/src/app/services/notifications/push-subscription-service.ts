import type { CreateSubscriptionInput, UpdateSubscriptionInput } from 'shared/schemas'
import { Result } from 'better-result'
import { pushSubscriptionRepository } from '#app/repositories/index.js'
import type { SerializedPushSubscription } from '#app/transformers/push-subscription-transformer.js'
import {
    pushNotificationLogTransformer,
    pushSubscriptionTransformer,
    type SerializedPushNotificationLog,
} from '#app/transformers/index.js'
import { conflict, internalMessage, notFound, type AppResult } from '#app/services/shared/errors.js'
import { getPushSubscriptionStatistics } from '#app/services/statistics/push-subscription-statistics-service.js'

export const pushSubscriptionService = {
    async getSubscriptions(userId: bigint): Promise<
        AppResult<{
            subscriptions: ReturnType<typeof pushSubscriptionTransformer.serializeArrayWithLogs>
        }>
    > {
        const subscriptions = await pushSubscriptionRepository.findByUserIdWithLogs(userId)

        return Result.ok({
            subscriptions: pushSubscriptionTransformer.serializeArrayWithLogs(subscriptions),
        })
    },

    async createSubscription(
        userId: bigint,
        payload: CreateSubscriptionInput,
    ): Promise<
        AppResult<{
            subscription: ReturnType<typeof pushSubscriptionTransformer.serialize>
        }>
    > {
        const existingSubscription = await pushSubscriptionRepository.findByEndpoint(
            payload.endpoint,
        )

        if (existingSubscription !== undefined) {
            // The endpoint is unique across users. Moving it to another account is
            // allowed only when the caller also proves possession of the browser's
            // keys (same device, account switch); a leaked endpoint alone is not enough.
            const ownedByAnotherUser = existingSubscription.userId !== userId
            const sameKeys =
                existingSubscription.p256dhKey === payload.p256dhKey &&
                existingSubscription.authKey === payload.authKey
            if (ownedByAnotherUser && !sameKeys) {
                return Result.err(conflict('Push subscription belongs to another user'))
            }

            const updated = await pushSubscriptionRepository.updateByEndpoint(
                payload.endpoint,
                userId,
                {
                    p256dhKey: payload.p256dhKey,
                    authKey: payload.authKey,
                    userAgent: payload.userAgent,
                    ipAddress: payload.ipAddress,
                    deviceType: payload.deviceType,
                    browserName: payload.browserName,
                    browserVersion: payload.browserVersion,
                    osName: payload.osName,
                    osVersion: payload.osVersion,
                    notificationTypes: payload.notificationTypes,
                    timezone: payload.timezone,
                    isActive: true,
                },
            )
            if (updated === undefined) {
                return Result.err(internalMessage('Failed to update subscription'))
            }

            return Result.ok({
                subscription: pushSubscriptionTransformer.serialize(updated),
            })
        }

        const created = await pushSubscriptionRepository.create({
            endpoint: payload.endpoint,
            p256dhKey: payload.p256dhKey,
            authKey: payload.authKey,
            userAgent: payload.userAgent ?? null,
            ipAddress: payload.ipAddress ?? null,
            deviceType: payload.deviceType ?? null,
            browserName: payload.browserName ?? null,
            browserVersion: payload.browserVersion ?? null,
            osName: payload.osName ?? null,
            osVersion: payload.osVersion ?? null,
            notificationTypes: payload.notificationTypes,
            timezone: payload.timezone ?? null,
            userId,
        })

        return Result.ok({
            subscription: pushSubscriptionTransformer.serialize(created),
        })
    },

    async getSubscription(
        userId: bigint,
        subscriptionId: bigint,
    ): Promise<
        AppResult<{
            data: SerializedPushSubscription & { notificationLogs: SerializedPushNotificationLog[] }
        }>
    > {
        const [subscription, logs] = await Promise.all([
            pushSubscriptionRepository.findByIdAndUserId(subscriptionId, userId),
            pushSubscriptionRepository.getLogsBySubscriptionId(subscriptionId, userId, 10),
        ])

        if (subscription === undefined) {
            return Result.err(notFound('Subscription', 'Subscription not found'))
        }

        return Result.ok({
            data: {
                ...pushSubscriptionTransformer.serialize(subscription),
                notificationLogs: pushNotificationLogTransformer.serializeArray(logs),
            },
        })
    },

    async updateSubscription(
        userId: bigint,
        subscriptionId: bigint,
        payload: UpdateSubscriptionInput,
    ): Promise<
        AppResult<{
            subscription: ReturnType<typeof pushSubscriptionTransformer.serialize>
        }>
    > {
        const updateData = {
            ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
            ...(payload.notificationTypes !== undefined
                ? { notificationTypes: payload.notificationTypes }
                : {}),
            ...(payload.timezone !== undefined ? { timezone: payload.timezone } : {}),
            ...(payload.deviceType !== undefined ? { deviceType: payload.deviceType } : {}),
            ...(payload.browserName !== undefined ? { browserName: payload.browserName } : {}),
            ...(payload.browserVersion !== undefined
                ? { browserVersion: payload.browserVersion }
                : {}),
            ...(payload.osName !== undefined ? { osName: payload.osName } : {}),
            ...(payload.osVersion !== undefined ? { osVersion: payload.osVersion } : {}),
        }

        const updated = await pushSubscriptionRepository.update(subscriptionId, userId, updateData)
        if (updated === undefined) {
            return Result.err(notFound('Subscription', 'Subscription not found'))
        }

        return Result.ok({
            subscription: pushSubscriptionTransformer.serialize(updated),
        })
    },

    async deleteSubscription(
        userId: bigint,
        subscriptionId: bigint,
    ): Promise<AppResult<{ message: string }>> {
        const deleted = await pushSubscriptionRepository.delete(subscriptionId, userId)
        if (!deleted) {
            return Result.err(notFound('Subscription', 'Subscription not found'))
        }

        return Result.ok({ message: 'Subscription deleted successfully' })
    },

    async getSubscriptionLogs(
        userId: bigint,
        subscriptionId: bigint,
    ): Promise<
        AppResult<{
            data: SerializedPushNotificationLog[]
        }>
    > {
        const logs = await pushSubscriptionRepository.getLogsBySubscriptionId(
            subscriptionId,
            userId,
            50,
        )

        return Result.ok({ data: pushNotificationLogTransformer.serializeArray(logs) })
    },

    async getSubscriptionStatistics(
        userId: bigint,
        subscriptionId: bigint,
    ): Promise<
        AppResult<{
            data: NonNullable<Awaited<ReturnType<typeof getPushSubscriptionStatistics>>>
        }>
    > {
        const data = await getPushSubscriptionStatistics(subscriptionId, userId)
        if (data === undefined) {
            return Result.err(notFound('Subscription', 'Subscription not found'))
        }

        return Result.ok({ data })
    },

    async deactivateSubscription(
        userId: bigint,
        subscriptionId: bigint,
    ): Promise<
        AppResult<{
            data: ReturnType<typeof pushSubscriptionTransformer.serialize>
        }>
    > {
        const deactivated = await pushSubscriptionRepository.deactivate(subscriptionId, userId)
        if (deactivated === undefined) {
            return Result.err(notFound('Subscription', 'Subscription not found'))
        }

        return Result.ok({
            data: pushSubscriptionTransformer.serialize(deactivated),
        })
    },
}
