import webpush from 'web-push'
import pushConfig from '#config/push.js'
import logger from '#logger'
import {
    pushNotificationLogRepository,
    pushSubscriptionRepository,
    type PushNotificationLogInsert,
    type PushSubscriptionRow,
} from '#app/repositories/index.js'
import { wsConnectionRegistry } from '#app/websocket/ws-connection-registry.js'
import { isAllowedPushEndpoint } from './push-endpoint-policy.js'
import { sendPush } from './push-transport.js'

/** feat-138: the longest one push request may take before it is abandoned and logged as failed. */
export const PUSH_SEND_TIMEOUT_MS = 10_000

export interface PushNotificationPayload {
    title: string
    body: string
    url?: string
    tag?: string
    icon?: string
    data?: Record<string, unknown>
}

// Push requests in flight per sendToUser call.
export const PUSH_SEND_CONCURRENCY = 5

let vapidConfigured = false

async function forEachWithConcurrency<T>(
    items: readonly T[],
    limit: number,
    run: (item: T) => Promise<void>,
): Promise<void> {
    let next = 0
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const item = items[next++] as T
            await run(item)
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

function acceptsType(subscription: PushSubscriptionRow, notificationType?: string): boolean {
    const types = subscription.notificationTypes
    return (
        notificationType === undefined ||
        !Array.isArray(types) ||
        types.length === 0 ||
        (types as string[]).includes(notificationType)
    )
}

function ensureVapidConfigured(): boolean {
    if (vapidConfigured) return true

    if (pushConfig.vapidPublicKey === '' || pushConfig.vapidPrivateKey === '') {
        logger.warn('VAPID keys not configured — push notifications disabled')
        return false
    }

    try {
        webpush.setVapidDetails(
            pushConfig.vapidSubject,
            pushConfig.vapidPublicKey,
            pushConfig.vapidPrivateKey,
        )
        vapidConfigured = true
        return true
    } catch (error) {
        logger.error({ err: error }, 'Failed to set VAPID details')
        return false
    }
}

function isUserOnline(userId: string): boolean {
    return wsConnectionRegistry.isUserOnline(userId)
}

export const pushNotificationSenderService = {
    isConfigured(): boolean {
        return ensureVapidConfigured()
    },

    getVapidPublicKey(): string {
        return pushConfig.vapidPublicKey
    },

    async sendToUser(
        userId: bigint,
        payload: PushNotificationPayload,
        options: { skipIfOnline?: boolean; notificationType?: string } = {},
    ): Promise<{ sent: number; failed: number }> {
        if (!ensureVapidConfigured()) {
            return { sent: 0, failed: 0 }
        }

        // Skip if user is online and option is set
        if (options.skipIfOnline === true && isUserOnline(String(userId))) {
            logger.info({ userId: String(userId) }, 'User is online, skipping push notification')
            return { sent: 0, failed: 0 }
        }

        const subscriptions = await pushSubscriptionRepository.findByUserId(userId)
        // feat-104: checked again before sending, so a row stored before the allowlist (or under a
        // wider one) never gets a request.
        const activeSubscriptions = subscriptions.filter((sub) => {
            if (!sub.isActive) return false
            if (isAllowedPushEndpoint(sub.endpoint)) return true
            logger.warn(
                { subscriptionId: String(sub.id) },
                'Push subscription endpoint is not allowed, skipping',
            )
            return false
        })

        if (activeSubscriptions.length === 0) {
            return { sent: 0, failed: 0 }
        }

        let sent = 0
        let failed = 0
        const logs: PushNotificationLogInsert[] = []
        const usedIds: bigint[] = []
        const expiredIds: bigint[] = []

        const pushPayload = JSON.stringify({
            notification: {
                title: payload.title,
                body: payload.body,
                icon: payload.icon ?? '/icons/icon_192x192.png',
                badge: '/icons/badge-72.png',
                vibrate: [200, 100, 200],
                data: {
                    url: payload.url ?? '/',
                    ...payload.data,
                },
                tag: payload.tag,
                actions: [
                    { action: 'open', title: 'Open' },
                    { action: 'close', title: 'Close' },
                ],
            },
        })

        const targets = activeSubscriptions.filter((subscription) =>
            acceptsType(subscription, options.notificationType),
        )

        await forEachWithConcurrency(targets, PUSH_SEND_CONCURRENCY, async (subscription) => {
            const base = {
                userId,
                subscriptionId: subscription.id,
                messageTitle: payload.title,
                messageBody: payload.body,
                messageData: payload.data ?? null,
            }
            try {
                const response = await sendPush(
                    {
                        endpoint: subscription.endpoint,
                        keys: {
                            p256dh: subscription.p256dhKey,
                            auth: subscription.authKey,
                        },
                    },
                    pushPayload,
                    // feat-138 (L13), feat-139 (Q4): a push service that hangs or trickles must not
                    // hold the send (and the loop over the user's subscriptions): one deadline over
                    // the whole request. No proxy or agent (feat-104).
                    { deadlineMs: PUSH_SEND_TIMEOUT_MS },
                )
                logs.push({
                    ...base,
                    status: 'SENT',
                    responseData: { statusCode: response.statusCode },
                    sentAt: new Date(),
                })
                usedIds.push(subscription.id)
                sent++
            } catch (error: unknown) {
                const statusCode = (error as { statusCode?: number }).statusCode
                const errorMessage = error instanceof Error ? error.message : String(error)
                logs.push({
                    ...base,
                    status: 'FAILED',
                    errorMessage,
                    responseData: { statusCode: statusCode ?? null },
                    sentAt: new Date(),
                })
                failed++
                logger.error(
                    { err: error, subscriptionId: String(subscription.id) },
                    'Failed to send push notification',
                )

                // 410 Gone or 404 — subscription expired, deactivate
                if (statusCode === 410 || statusCode === 404) {
                    logger.info(
                        { subscriptionId: String(subscription.id), statusCode },
                        'Push subscription expired, deactivating',
                    )
                    expiredIds.push(subscription.id)
                }
            }
        })

        // Bookkeeping after the sends: a failed write must not turn a delivered
        // notification into a failure in the result.
        try {
            await pushNotificationLogRepository.insertMany(logs)
            if (usedIds.length > 0) {
                await pushSubscriptionRepository.touchLastUsed(usedIds, userId)
            }
        } catch (error: unknown) {
            logger.error(
                { err: error, userId: String(userId), logs: logs.length },
                'Failed to record push notification results',
            )
        }
        // Separate from the log write: a failed deactivation must not lose the logs.
        for (const id of expiredIds) {
            try {
                await pushSubscriptionRepository.deactivate(id, userId)
            } catch (error: unknown) {
                logger.error(
                    { err: error, subscriptionId: String(id) },
                    'Failed to deactivate an expired push subscription',
                )
            }
        }

        return { sent, failed }
    },
}
