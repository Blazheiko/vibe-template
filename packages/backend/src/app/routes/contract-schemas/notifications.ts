import {
    EmptyFormInputSchema,
    ListNotificationsQuerySchema,
    ReadAllNotificationsInputSchema,
    UpdateNotificationPreferenceInputSchema,
} from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { notificationContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

// feat-236 (Р4, Р6): the notification center.
export const notificationSchemas = contractSchemas(notificationContracts, {
    list: {
        query: ListNotificationsQuerySchema,
        response: ResponseSchemas.ListNotificationsResponseSchema,
    },
    unreadCount: { response: ResponseSchemas.UnreadNotificationsCountResponseSchema },
    markRead: {
        body: EmptyFormInputSchema,
        response: ResponseSchemas.MarkNotificationReadResponseSchema,
    },
    readAll: {
        body: ReadAllNotificationsInputSchema,
        response: ResponseSchemas.ReadAllNotificationsResponseSchema,
    },
    getPreferences: { response: ResponseSchemas.NotificationPreferencesResponseSchema },
    updatePreference: {
        body: UpdateNotificationPreferenceInputSchema,
        response: ResponseSchemas.NotificationPreferencesResponseSchema,
    },
})
