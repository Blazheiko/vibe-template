import type { EmptyFormInputSchema } from '../schemas/common/empty-form.js'
import type { ListNotificationsQueryInput } from '../schemas/query/notifications.js'
import type {
    ReadAllNotificationsInputSchema,
    UpdateNotificationPreferenceInputSchema,
} from '../schemas/notifications/requests.js'
import type {
    ListNotificationsResponse,
    MarkNotificationReadResponse,
    NotificationPreferencesResponse,
    ReadAllNotificationsResponse,
    UnreadNotificationsCountResponse,
} from '../responses/notifications-controller.js'
import { contract } from './core.js'

// feat-236 (Р4, Р6): the notification center. Only types are imported from the schemas.
export const notificationContracts = {
    list: contract<undefined, ListNotificationsQueryInput, ListNotificationsResponse>()(
        'get',
        '/notifications',
    ),
    unreadCount: contract<undefined, undefined, UnreadNotificationsCountResponse>()(
        'get',
        '/notifications/unread-count',
    ),
    // Idempotent: a notification read already answers the same `link`.
    markRead: contract<
        typeof EmptyFormInputSchema.inferIn,
        undefined,
        MarkNotificationReadResponse
    >()('post', '/notifications/:id/read'),
    readAll: contract<
        typeof ReadAllNotificationsInputSchema.inferIn,
        undefined,
        ReadAllNotificationsResponse
    >()('post', '/notifications/read-all'),
    getPreferences: contract<undefined, undefined, NotificationPreferencesResponse>()(
        'get',
        '/notifications/preferences',
    ),
    updatePreference: contract<
        typeof UpdateNotificationPreferenceInputSchema.inferIn,
        undefined,
        NotificationPreferencesResponse
    >()('put', '/notifications/preferences'),
} as const
