import type { CreateSubscriptionInput, UpdateSubscriptionInput } from 'shared/schemas'
import { Result } from 'better-result'
import { pushSubscriptionRepository } from '#app/repositories/index.js'
import type { SerializedPushSubscription } from '#app/transformers/push-subscription-transformer.js'
import {
    pushNotificationLogTransformer,
    pushSubscriptionTransformer,
    type SerializedPushNotificationLog,
} from '#app/transformers/index.js'
import {
    badRequest,
    conflict,
    internalMessage,
    notFound,
    type AppResult,
} from '#app/services/shared/errors.js'
import pushConfig from '#config/push.js'
import { canonicalPushEndpoint } from './push-endpoint-policy.js'
import type { DbTransaction } from '#app/repositories/index.js'
import { getPushSubscriptionStatistics } from '#app/services/statistics/push-subscription-statistics-service.js'
import { withCurrentSession } from '#app/services/auth/session-guard.js'

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

    /**
     * feat-098: written under the user's row lock and only while the request's session is
     * current, so a request admitted before a claim cannot add a device after it.
     */
    async createSubscription(
        userId: bigint,
        payload: CreateSubscriptionInput,
        presentedSessionToken: string | undefined,
        /**
         * The address the request came from, as the server sees it (feat-156); never a value
         * from the request body. Without one (a call that is not an HTTP request) none is stored.
         */
        clientIp: string | null = null,
    ): Promise<
        AppResult<{
            subscription: ReturnType<typeof pushSubscriptionTransformer.serialize>
        }>
    > {
        const ipAddress = storableIp(clientIp)
        return await withCurrentSession(userId, presentedSessionToken, (tx) =>
            upsertSubscription(userId, payload, ipAddress, tx),
        )
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

    /** feat-098: like `createSubscription`, only while the request's session is current. */
    async updateSubscription(
        userId: bigint,
        subscriptionId: bigint,
        payload: UpdateSubscriptionInput,
        presentedSessionToken: string | undefined,
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

        return await withCurrentSession(userId, presentedSessionToken, async (tx) => {
            const updated = await pushSubscriptionRepository.update(
                subscriptionId,
                userId,
                updateData,
                tx,
            )
            if (updated === undefined) {
                return Result.err(notFound('Subscription', 'Subscription not found'))
            }
            return Result.ok({ subscription: pushSubscriptionTransformer.serialize(updated) })
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

// push_subscriptions.ip_address is varchar(45): an IPv6 address with an IPv4 tail. An address
// that does not fit (a zone id, a placeholder) is not stored rather than failing the request.
const IP_COLUMN_LENGTH = 45
const storableIp = (ip: string | null | undefined): string | null =>
    typeof ip === 'string' && ip !== '' && ip.length <= IP_COLUMN_LENGTH ? ip : null

async function upsertSubscription(
    userId: bigint,
    payload: CreateSubscriptionInput,
    ipAddress: string | null,
    tx: DbTransaction,
): Promise<AppResult<{ subscription: SerializedPushSubscription }>> {
    // feat-104: the server POSTs to this URL; only the allowed push services are stored.
    // feat-125: in its canonical form, so two spellings of one endpoint are one endpoint.
    const endpoint = canonicalPushEndpoint(payload.endpoint)
    if (endpoint === null) {
        return Result.err(badRequest('Push endpoint is not allowed', 'push_endpoint_not_allowed'))
    }

    const existingSubscription = await pushSubscriptionRepository.findByEndpoint(endpoint, tx)

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
        if (ownedByAnotherUser) {
            const limited = await subscriptionLimitReached(userId, tx)
            if (limited !== undefined) return limited
        }

        const updated = await pushSubscriptionRepository.updateByEndpoint(
            endpoint,
            userId,
            {
                p256dhKey: payload.p256dhKey,
                authKey: payload.authKey,
                userAgent: payload.userAgent,
                ipAddress,
                deviceType: payload.deviceType,
                browserName: payload.browserName,
                browserVersion: payload.browserVersion,
                osName: payload.osName,
                osVersion: payload.osVersion,
                notificationTypes: payload.notificationTypes,
                timezone: payload.timezone,
                isActive: true,
            },
            tx,
        )
        if (updated === undefined) {
            return Result.err(internalMessage('Failed to update subscription'))
        }

        return Result.ok({
            subscription: pushSubscriptionTransformer.serialize(updated),
        })
    }

    const limited = await subscriptionLimitReached(userId, tx)
    if (limited !== undefined) return limited

    const created = await pushSubscriptionRepository.create(
        {
            endpoint: endpoint,
            p256dhKey: payload.p256dhKey,
            authKey: payload.authKey,
            userAgent: payload.userAgent ?? null,
            ipAddress,
            deviceType: payload.deviceType ?? null,
            browserName: payload.browserName ?? null,
            browserVersion: payload.browserVersion ?? null,
            osName: payload.osName ?? null,
            osVersion: payload.osVersion ?? null,
            notificationTypes: payload.notificationTypes,
            timezone: payload.timezone ?? null,
            userId,
        },
        tx,
    )

    return Result.ok({
        subscription: pushSubscriptionTransformer.serialize(created),
    })
}

// Counted under the user's row lock that withCurrentSession holds, so two requests cannot both
// pass with one slot left.
async function subscriptionLimitReached(
    userId: bigint,
    tx: DbTransaction,
): Promise<AppResult<never> | undefined> {
    const total = await pushSubscriptionRepository.countByUserId(userId, tx)
    if (total < pushConfig.maxSubscriptionsPerUser) return undefined
    return Result.err(
        conflict('Too many push subscriptions for this account', 'push_subscription_limit'),
    )
}
