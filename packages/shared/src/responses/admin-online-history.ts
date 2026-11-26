import { type } from '@arktype/type'
import { EntityIdSchema } from '../brands/ids.js'
import { CursorSchema, IsoDateTimeSchema } from '../brands/wire.js'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

export const AdminOnlineHistoryListItemSchema = type({
    id: EntityIdSchema,
    userId: EntityIdSchema,
    name: 'string',
    email: 'string',
    appType: "'web' | 'pwa' | null",
    connectedAt: IsoDateTimeSchema,
    disconnectedAt: IsoDateTimeSchema.or('null'),
    connectionDurationMs: 'number | null',
    closeCode: 'number | null',
    isFirstConnection: 'boolean',
    isLastConnection: 'boolean | null',
    userAgent: 'string | null',
    ipAddress: 'string | null',
})
export type AdminOnlineHistoryListItem = typeof AdminOnlineHistoryListItemSchema.infer

export const AdminOnlineHistoryListResponseSchema = type.or(
    {
        status: "'success'",
        items: AdminOnlineHistoryListItemSchema.array(),
        total: 'number',
        limit: 'number',
        nextCursor: CursorSchema.or('null'),
        hasMore: 'boolean',
    },
    CanonicalErrorResponseSchema,
)
export type AdminOnlineHistoryListResponse = WithCanonicalError<
    typeof AdminOnlineHistoryListResponseSchema.infer
>
