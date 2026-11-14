import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

export const AdminUserListItemSchema = type({
    id: 'string',
    name: 'string',
    email: 'string',
    registeredAt: 'string',
})
export type AdminUserListItem = typeof AdminUserListItemSchema.infer

export const AdminUserListResponseSchema = type.or(
    {
        status: "'success'",
        items: AdminUserListItemSchema.array(),
        total: 'number',
        /** The id to pass as `cursor` for the next page, or null on the last one. */
        nextCursor: 'string | null',
        hasMore: 'boolean',
    },
    CanonicalErrorResponseSchema,
)
export type AdminUserListResponse = WithCanonicalError<typeof AdminUserListResponseSchema.infer>
