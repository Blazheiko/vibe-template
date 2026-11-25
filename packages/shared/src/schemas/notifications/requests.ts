import { type } from '@arktype/type'
import { EntityIdStringSchema } from '../../brands/ids.js'
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS } from '../../notifications/catalog.js'

// POST /notifications/read-all (Р6): every notification with `id <= upTo`, an id PostgreSQL's
// bigint holds (feat-262).
export const ReadAllNotificationsInputSchema = type({
    upTo: EntityIdStringSchema,
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
