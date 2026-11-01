import { type } from '@arktype/type'
import { DateFromString, LimitIntFromString, PaginationFields } from './common.js'
import type { DateRangeQueryInput, PaginationQueryInput } from './common.js'
import type { PositiveIntInput } from './types.js'

export type AdminUserListQueryInput = DateRangeQueryInput & {
    userId?: string
    limit?: PositiveIntInput
}

export const AdminUserListQuerySchema = type({
    'dateFrom?': DateFromString,
    'dateTo?': DateFromString,
    'userId?': 'string',
    limit: LimitIntFromString.default('50'),
})

export type AdminUserListQuery = typeof AdminUserListQuerySchema.infer

export type AdminOnlineHistoryListQueryInput = AdminUserListQueryInput & {
    cursor?: string
}

export const AdminOnlineHistoryListQuerySchema = type({
    'dateFrom?': DateFromString,
    'dateTo?': DateFromString,
    'userId?': 'string',
    'cursor?': 'string',
    limit: LimitIntFromString.default('50'),
})

export type AdminOnlineHistoryListQuery = typeof AdminOnlineHistoryListQuerySchema.infer

export type AdminKnowledgeBaseListQueryInput = PaginationQueryInput & {
    category?: string
}

export const AdminKnowledgeBaseListQuerySchema = type({
    ...PaginationFields,
    'category?': 'string',
})

export type AdminKnowledgeBaseListQuery = typeof AdminKnowledgeBaseListQuerySchema.infer
