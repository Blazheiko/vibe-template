import { type } from '@arktype/type'
import { PaginationFields, DateRangeFields } from './common.js'
import type { QueryInputOf } from './types.js'

export type LlmTextUsageFeature =
    'SUPPORT_CHAT' | 'SUPPORT_QUERY_TRANSLATION' | 'PROMPT_TEST' | 'SUPPORT_EMBEDDING'

export const LlmTextUsageQuerySchema = type({
    ...PaginationFields,
    ...DateRangeFields,
    'userId?': 'string',
    'feature?':
        "'SUPPORT_CHAT' | 'SUPPORT_QUERY_TRANSLATION' | 'PROMPT_TEST' | 'SUPPORT_EMBEDDING'",
})

export type LlmTextUsageQuery = typeof LlmTextUsageQuerySchema.infer
export type LlmTextUsageQueryInput = QueryInputOf<typeof LlmTextUsageQuerySchema>
