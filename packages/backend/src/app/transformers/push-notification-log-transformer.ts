import type { PushNotificationLogRow, PushSubscriptionLogSummary } from '#app/repositories/index.js'

// Wire shape of push_notifications_log rows (feat-047): ids as strings, sentAt as an ISO
// string, as makeJson / JSON.stringify would send them anyway. feat-104: the transport error
// text and raw response stay in the database; the client gets the status code and a reason.
export type PushDeliveryReason = 'gone' | 'rejected' | 'network_error'

export type SerializedPushNotificationLog = Omit<
    PushNotificationLogRow,
    'id' | 'userId' | 'subscriptionId' | 'sentAt' | 'errorMessage' | 'responseData'
> & {
    id: string
    userId: string | null
    subscriptionId: string | null
    sentAt: string
    statusCode: number | null
    reason: PushDeliveryReason | null
}

function deliveryReason(
    status: PushNotificationLogRow['status'],
    statusCode: number | null,
): PushDeliveryReason | null {
    if (status !== 'FAILED') return null
    if (statusCode === null) return 'network_error'
    return statusCode === 404 || statusCode === 410 ? 'gone' : 'rejected'
}

export type SerializedPushLogSummary = Omit<PushSubscriptionLogSummary, 'id' | 'sentAt'> & {
    id: string
    sentAt: string
}

export const pushNotificationLogTransformer = {
    serialize(log: PushNotificationLogRow): SerializedPushNotificationLog {
        const {
            id,
            userId,
            subscriptionId,
            sentAt,
            errorMessage: _errorMessage,
            responseData,
            ...rest
        } = log
        const statusCode =
            typeof responseData?.statusCode === 'number' ? responseData.statusCode : null
        return {
            ...rest,
            id: String(id),
            userId: userId === null ? null : String(userId),
            subscriptionId: subscriptionId === null ? null : String(subscriptionId),
            sentAt: sentAt.toISOString(),
            statusCode,
            reason: deliveryReason(rest.status, statusCode),
        }
    },

    serializeArray(logs: PushNotificationLogRow[]): SerializedPushNotificationLog[] {
        return logs.map((log) => pushNotificationLogTransformer.serialize(log))
    },

    serializeSummary(log: PushSubscriptionLogSummary): SerializedPushLogSummary {
        const { id, sentAt, ...rest } = log
        return { ...rest, id: String(id), sentAt: sentAt.toISOString() }
    },
}
