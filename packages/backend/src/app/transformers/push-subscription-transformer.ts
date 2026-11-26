import type { PushSubscriptionRow, PushSubscriptionWithLogs } from '#app/repositories/index.js'
import { toIsoDateTimeOrNull, type EntityId, type IsoDateTime } from 'shared/brand'
import { toEntityId } from '#app/domain/ids.js'
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
    id: EntityId
    userId: EntityId
    created_at: string | null
    updated_at: string | null
    lastUsedAt: IsoDateTime | null
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
    id: EntityId
    userId: EntityId
    created_at: string | null
    updated_at: string | null
    lastUsedAt: IsoDateTime | null
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
            id: toEntityId(id),
            userId: toEntityId(userId),
            created_at: createdAt.toISOString(),
            updated_at: updatedAt.toISOString(),
            lastUsedAt: toIsoDateTimeOrNull(lastUsedAt),
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
            id: toEntityId(id),
            userId: toEntityId(userId),
            created_at: createdAt.toISOString(),
            updated_at: updatedAt.toISOString(),
            lastUsedAt: toIsoDateTimeOrNull(lastUsedAt),
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
