import { type } from '@arktype/type'
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS } from '../../notifications/catalog.js'

/** A notification id as a client sends it: a positive decimal that may fit a bigint (Р6). */
export const NOTIFICATION_ID_PATTERN = /^[1-9]\d{0,18}$/

// POST /notifications/read-all (Р6): every notification with `id <= upTo`. The backend also
// checks that `upTo` fits a PostgreSQL bigint before the query.
export const ReadAllNotificationsInputSchema = type({
    upTo: NOTIFICATION_ID_PATTERN,
    '+': 'reject',
})
export type ReadAllNotificationsInput = typeof ReadAllNotificationsInputSchema.infer

// PUT /notifications/preferences (Р4): one cell of the matrix. A locked channel or one the
// category does not have is refused by the backend with 422.
export const UpdateNotificationPreferenceInputSchema = type({
    category: type.enumerated(...NOTIFICATION_CATEGORIES),
    channel: type.enumerated(...NOTIFICATION_CHANNELS),
    enabled: 'boolean',
    '+': 'reject',
})
export type UpdateNotificationPreferenceInput = typeof UpdateNotificationPreferenceInputSchema.infer
