import { type } from '@arktype/type'
import { PaginationFields, DateRangeFields } from './common.js'
import type { DateRangeQueryInput, PaginationQueryInput } from './common.js'

export type LlmTextUsageFeature =
    'SUPPORT_CHAT' | 'SUPPORT_QUERY_TRANSLATION' | 'PROMPT_TEST' | 'SUPPORT_EMBEDDING'

export interface BaseUsageQuery<TFeature extends string> {
    page: number
    limit: number
    userId?: string
    dateFrom?: Date
    dateTo?: Date
    feature?: TFeature
}

export type BaseUsageQueryInput<TFeature extends string> = PaginationQueryInput &
    DateRangeQueryInput & {
        userId?: string
        feature?: TFeature
    }

export type LlmTextUsageQueryInput = BaseUsageQueryInput<LlmTextUsageFeature>

export const LlmTextUsageQuerySchema = type({
    ...PaginationFields,
    ...DateRangeFields,
    'userId?': 'string',
    'feature?':
        "'SUPPORT_CHAT' | 'SUPPORT_QUERY_TRANSLATION' | 'PROMPT_TEST' | 'SUPPORT_EMBEDDING'",
})

export type LlmTextUsageQuery = typeof LlmTextUsageQuerySchema.infer
