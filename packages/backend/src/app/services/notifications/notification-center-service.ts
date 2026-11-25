import { Result } from 'better-result'
import {
    NOTIFICATION_CHANNEL_LOCKED_REASON,
    NOTIFICATION_CHANNEL_UNAVAILABLE_REASON,
    channelPolicyOf,
    resolveNotificationPreferences,
    type NotificationCategory,
    type NotificationChannel,
    type NotificationPreference,
} from 'shared/notifications'
import type { NotificationItem } from 'shared/responses'

import logger from '#vendor/utils/logger.js'
import {
    notificationPreferenceRepository,
    notificationRepository,
} from '#app/repositories/index.js'
import { userEventBus } from '#app/services/communication/user-event-bus.js'
import { badRequest, notFound, type AppError, type AppResult } from '#app/services/shared/errors.js'
import { notificationTransformer } from '#app/transformers/index.js'
import type { UserId } from '#app/domain/ids.js'

// feat-236 (Р4, Р6): what the notification center answers. Every call is bound to the user of the
// session; a notification of somebody else is answered like a missing one.

const notificationNotFound = (): AppError => notFound('Notification', 'Notification not found')

/** Tells the user's other tabs and devices to read again (Р8). Best effort, never awaited. */
const signal = (
    userId: UserId,
    event: 'notifications_changed' | 'notification_preferences_changed',
): void => {
    userEventBus.publishToUser(String(userId), event, {}).catch((err: unknown) => {
        logger.warn({ err, userId: String(userId), event }, 'Notification signal not published')
    })
}

export interface NotificationsPage {
    items: NotificationItem[]
    next: string | null
    unreadCount: number
}

export const notificationCenterService = {
    async list(
        userId: UserId,
        options: { unread: boolean; before: bigint | null; limit: number },
    ): Promise<AppResult<NotificationsPage>> {
        const page = await notificationRepository.page(userId, options)
        const unreadCount = await notificationRepository.countUnread(userId)
        return Result.ok({
            items: page.rows.map((row) => notificationTransformer.serialize(row)),
            next: page.next === null ? null : String(page.next),
            unreadCount,
        })
    },

    async unreadCount(userId: UserId): Promise<AppResult<{ unreadCount: number }>> {
        return Result.ok({ unreadCount: await notificationRepository.countUnread(userId) })
    },

    /** Idempotent: a notification read already answers its link again (Р6). */
    async markRead(
        userId: UserId,
        id: bigint,
    ): Promise<AppResult<{ link: string | null; unreadCount: number }>> {
        const read = await notificationRepository.markRead(userId, id)
        if (read === null) return Result.err(notificationNotFound())
        signal(userId, 'notifications_changed')
        return Result.ok({
            link: read.link,
            unreadCount: await notificationRepository.countUnread(userId),
        })
    },

    /** Every notification with `id <= upTo`, older pages included (Р6). */
    async readAll(userId: UserId, upTo: bigint): Promise<AppResult<{ unreadCount: number }>> {
        await notificationRepository.markAllUpTo(userId, upTo)
        signal(userId, 'notifications_changed')
        return Result.ok({ unreadCount: await notificationRepository.countUnread(userId) })
    },

    async getPreferences(userId: UserId): Promise<AppResult<NotificationPreference[]>> {
        const rows = await notificationPreferenceRepository.findByUserId(userId)
        return Result.ok(resolveNotificationPreferences(rows))
    },

    /** One cell of the matrix (Р4); a locked or absent channel is refused. */
    async updatePreference(
        userId: UserId,
        input: { category: NotificationCategory; channel: NotificationChannel; enabled: boolean },
    ): Promise<AppResult<NotificationPreference[]>> {
        const policy = channelPolicyOf(input.category, input.channel)
        if (policy === undefined) {
            return Result.err(
                badRequest(
                    'This category has no such channel',
                    NOTIFICATION_CHANNEL_UNAVAILABLE_REASON,
                ),
            )
        }
        if (policy.locked) {
            return Result.err(
                badRequest('This channel cannot be changed', NOTIFICATION_CHANNEL_LOCKED_REASON),
            )
        }
        await notificationPreferenceRepository.upsert(
            userId,
            input.category,
            input.channel,
            input.enabled,
        )
        signal(userId, 'notification_preferences_changed')
        return this.getPreferences(userId)
    },
}
