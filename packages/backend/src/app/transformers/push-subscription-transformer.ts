import type { PushSubscriptionRow, PushSubscriptionWithLogs } from '#app/repositories/index.js'
import {
    pushNotificationLogTransformer,
    type SerializedPushLogSummary,
} from './push-notification-log-transformer.js'

// feat-208: the encryption keys of a subscription and the address it was created from stay on
// the server. The owner's browser has the keys already, and no client reads them back.
type ServerOnlyField = 'p256dhKey' | 'authKey' | 'ipAddress'

export type SerializedPushSubscription = Omit<
    PushSubscriptionRow,
    'id' | 'userId' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | ServerOnlyField
> & {
    id: string
    userId: string
    created_at: string | null
    updated_at: string | null
    lastUsedAt: string | null
}

export type SerializedPushSubscriptionWithLogs = Omit<
    PushSubscriptionWithLogs,
    | 'id'
    | 'userId'
    | 'createdAt'
    | 'updatedAt'
    | 'lastUsedAt'
    | 'notificationLogs'
    | ServerOnlyField
> & {
    notificationLogs: SerializedPushLogSummary[]
    id: string
    userId: string
    created_at: string | null
    updated_at: string | null
    lastUsedAt: string | null
}

export const pushSubscriptionTransformer = {
    serialize(subscription: PushSubscriptionRow): SerializedPushSubscription {
        const {
            createdAt,
            updatedAt,
            lastUsedAt,
            id,
            userId,
            p256dhKey: _p256dhKey,
            authKey: _authKey,
            ipAddress: _ipAddress,
            ...rest
        } = subscription
        return {
            ...rest,
            id: String(id),
            userId: String(userId),
            created_at: createdAt.toISOString(),
            updated_at: updatedAt.toISOString(),
            lastUsedAt: lastUsedAt !== null ? lastUsedAt.toISOString() : null,
        }
    },

    serializeWithLogs(subscription: PushSubscriptionWithLogs): SerializedPushSubscriptionWithLogs {
        const {
            createdAt,
            updatedAt,
            lastUsedAt,
            id,
            userId,
            notificationLogs,
            p256dhKey: _p256dhKey,
            authKey: _authKey,
            ipAddress: _ipAddress,
            ...rest
        } = subscription
        return {
            ...rest,
            notificationLogs: notificationLogs.map((log) =>
                pushNotificationLogTransformer.serializeSummary(log),
            ),
            id: String(id),
            userId: String(userId),
            created_at: createdAt.toISOString(),
            updated_at: updatedAt.toISOString(),
            lastUsedAt: lastUsedAt !== null ? lastUsedAt.toISOString() : null,
        }
    },

    serializeArray(subscriptions: PushSubscriptionRow[]): SerializedPushSubscription[] {
        return subscriptions.map((s) => pushSubscriptionTransformer.serialize(s))
    },

    serializeArrayWithLogs(
        subscriptions: PushSubscriptionWithLogs[],
    ): SerializedPushSubscriptionWithLogs[] {
        return subscriptions.map((s) => pushSubscriptionTransformer.serializeWithLogs(s))
    },
}
