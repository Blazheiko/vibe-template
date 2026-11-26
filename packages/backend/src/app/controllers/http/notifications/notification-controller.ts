import type {
    ListNotificationsQuery,
    ReadAllNotificationsInput,
    UpdateNotificationPreferenceInput,
} from 'shared/schemas'
import type {
    ListNotificationsResponse,
    MarkNotificationReadResponse,
    NotificationPreferencesResponse,
    ReadAllNotificationsResponse,
    UnreadNotificationsCountResponse,
} from 'shared/responses'

import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { parseNotificationId, type NotificationId } from '#app/domain/ids.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { notificationCenterService } from '#app/services/notifications/notification-center-service.js'
import { badRequest, notFound, unauthorized } from '#app/services/shared/errors.js'

// feat-236 (Р4, Р6): the notification center of the signed-in user. An id is parsed to a bigint
// PostgreSQL can hold before any query (parseNotificationId): a path id outside it is answered like a
// missing notification, a cursor or bound outside it is a bad request.

export default {
    async list(
        context: HttpContext<unknown, ListNotificationsQuery>,
    ): Promise<ListNotificationsResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const { unread, before, limit } = context.httpData.query
        let beforeId: NotificationId | null = null
        if (before !== undefined) {
            beforeId = parseNotificationId(before)
            if (beforeId === null) {
                return mapControllerError(context, badRequest('Invalid cursor', 'invalid_cursor'))
            }
        }
        const result = await notificationCenterService.list(userId, {
            unread: unread === '1',
            before: beforeId,
            limit,
        })
        return respond(context, result, (page) => ({ status: 'success' as const, ...page }))
    },

    async unreadCount(context: HttpContext): Promise<UnreadNotificationsCountResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await notificationCenterService.unreadCount(userId)
        return respond(context, result, (count) => ({ status: 'success' as const, ...count }))
    },

    async markRead(
        context: HttpContext<unknown, null, { id: string }>,
    ): Promise<MarkNotificationReadResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const id = parseNotificationId(context.httpData.params.id)
        // Not an id of anything: the same answer as a notification of another user.
        if (id === null) {
            return mapControllerError(context, notFound('Notification', 'Notification not found'))
        }
        const result = await notificationCenterService.markRead(userId, id)
        return respond(context, result, (read) => ({ status: 'success' as const, ...read }))
    },

    async readAll(
        context: HttpContext<ReadAllNotificationsInput>,
    ): Promise<ReadAllNotificationsResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const upTo = parseNotificationId(getTypedPayload(context).upTo)
        if (upTo === null) {
            return mapControllerError(context, badRequest('Invalid upTo', 'invalid_up_to'))
        }
        const result = await notificationCenterService.readAll(userId, upTo)
        return respond(context, result, (count) => ({ status: 'success' as const, ...count }))
    },

    async getPreferences(context: HttpContext): Promise<NotificationPreferencesResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await notificationCenterService.getPreferences(userId)
        return respond(context, result, (preferences) => ({
            status: 'success' as const,
            preferences,
        }))
    },

    async updatePreference(
        context: HttpContext<UpdateNotificationPreferenceInput>,
    ): Promise<NotificationPreferencesResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())
        const result = await notificationCenterService.updatePreference(
            userId,
            getTypedPayload(context),
        )
        return respond(context, result, (preferences) => ({
            status: 'success' as const,
            preferences,
        }))
    },
}
