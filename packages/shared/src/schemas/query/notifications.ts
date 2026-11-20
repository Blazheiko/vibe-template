import { type } from '@arktype/type'
import { NOTIFICATIONS_PAGE_DEFAULT, NOTIFICATIONS_PAGE_MAX } from '../../notifications/catalog.js'
import { NOTIFICATION_ID_PATTERN } from '../notifications/requests.js'
import type { QueryInputOf } from './types.js'

const pageLimit = type('string.integer.parse').pipe(
    type('number > 0').atMost(NOTIFICATIONS_PAGE_MAX),
)

// feat-236 (Р6): GET /notifications. Keyset by id, newest first: `before` is the `next` of the
// previous page. `unread=1` lists only the unread ones.
export const ListNotificationsQuerySchema = type({
    'unread?': "'1'",
    'before?': NOTIFICATION_ID_PATTERN,
    limit: pageLimit.default(String(NOTIFICATIONS_PAGE_DEFAULT)),
    '+': 'reject',
})

export type ListNotificationsQuery = typeof ListNotificationsQuerySchema.infer
export type ListNotificationsQueryInput = QueryInputOf<typeof ListNotificationsQuerySchema>
