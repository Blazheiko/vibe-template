import { type } from '@arktype/type'
import {
    SUPPORT_HISTORY_DEFAULT_PAGE_SIZE,
    SUPPORT_HISTORY_MAX_PAGE_SIZE,
} from '../../limits/index.js'

export interface SupportChatHistoryQueryInput {
    before?: string
    limit?: string | number
}

const historyLimitFromString = type('string.integer.parse').pipe(
    type('number > 0').atMost(SUPPORT_HISTORY_MAX_PAGE_SIZE),
)

export const SupportChatHistoryQuerySchema = type({
    // A row id that fits a bigint column: at most 18 digits, no leading zero.
    'before?': /^[1-9]\d{0,17}$/,
    limit: historyLimitFromString.default(String(SUPPORT_HISTORY_DEFAULT_PAGE_SIZE)),
})

export type SupportChatHistoryQuery = typeof SupportChatHistoryQuerySchema.infer
