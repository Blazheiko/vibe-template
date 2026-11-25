import { type } from '@arktype/type'
import { EntityIdStringSchema } from '../../brands/ids.js'
import {
    SUPPORT_HISTORY_DEFAULT_PAGE_SIZE,
    SUPPORT_HISTORY_MAX_PAGE_SIZE,
} from '../../limits/index.js'
import type { QueryInputOf } from './types.js'

const historyLimitFromString = type('string.integer.parse').pipe(
    type('number > 0').atMost(SUPPORT_HISTORY_MAX_PAGE_SIZE),
)

export const SupportChatHistoryQuerySchema = type({
    // A row id that fits a bigint column (feat-262): the service reads it without parsing it again.
    'before?': EntityIdStringSchema,
    limit: historyLimitFromString.default(String(SUPPORT_HISTORY_DEFAULT_PAGE_SIZE)),
})

export type SupportChatHistoryQuery = typeof SupportChatHistoryQuerySchema.infer
export type SupportChatHistoryQueryInput = QueryInputOf<typeof SupportChatHistoryQuerySchema>
