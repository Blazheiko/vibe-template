import { type } from '@arktype/type'
import { DateFromString, LimitIntFromString, PaginationFields } from './common.js'
import type { QueryInputOf } from './types.js'

export const AdminUserListQuerySchema = type({
    'dateFrom?': DateFromString,
    'dateTo?': DateFromString,
    'userId?': 'string',
    /** The `nextCursor` of the previous page. */
    'cursor?': 'string',
    limit: LimitIntFromString.default('50'),
})

export type AdminUserListQuery = typeof AdminUserListQuerySchema.infer
export type AdminUserListQueryInput = QueryInputOf<typeof AdminUserListQuerySchema>

export const AdminOnlineHistoryListQuerySchema = type({
    'dateFrom?': DateFromString,
    'dateTo?': DateFromString,
    'userId?': 'string',
    'cursor?': 'string',
    limit: LimitIntFromString.default('50'),
})

export type AdminOnlineHistoryListQuery = typeof AdminOnlineHistoryListQuerySchema.infer
export type AdminOnlineHistoryListQueryInput = QueryInputOf<
    typeof AdminOnlineHistoryListQuerySchema
>

export const AdminKnowledgeBaseListQuerySchema = type({
    ...PaginationFields,
    'category?': 'string',
})

export type AdminKnowledgeBaseListQuery = typeof AdminKnowledgeBaseListQuerySchema.infer
export type AdminKnowledgeBaseListQueryInput = QueryInputOf<
    typeof AdminKnowledgeBaseListQuerySchema
>
