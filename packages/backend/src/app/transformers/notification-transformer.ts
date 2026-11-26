import type { NotificationItem } from 'shared/responses'
import { toEntityId } from '#app/domain/ids.js'

import type { NotificationRow } from '#app/repositories/index.js'

// feat-236 (Р1): the wire shape of a notification. Ids as strings, dates as ISO strings. The
// row's kind, category and params were checked against the catalog when it was written; the
// response schema checks them again on the way out.
export const notificationTransformer = {
    serialize(row: NotificationRow): NotificationItem {
        return {
            id: toEntityId(row.id),
            kind: row.kind,
            category: row.category,
            params: row.params,
            link: row.link,
            createdAt: row.createdAt.toISOString(),
            readAt: row.readAt === null ? null : row.readAt.toISOString(),
        } as NotificationItem
    },
}
