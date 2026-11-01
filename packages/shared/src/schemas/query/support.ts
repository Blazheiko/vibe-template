import { type } from '@arktype/type'
import {
    SUPPORT_HISTORY_DEFAULT_PAGE_SIZE,
    SUPPORT_HISTORY_MAX_PAGE_SIZE,
} from '../../limits/index.js'
import type { SharedQuerySchema } from './types.js'

interface SupportChatHistoryQueryOutput {
    /** Id of the oldest message the client already has; the page ends just before it. */
    before?: string
    limit: number
}

export interface SupportChatHistoryQueryInput {
    before?: string
    limit?: string | number
}

const historyLimitFromString = type('string.integer.parse').pipe(
    type('number > 0').atMost(SUPPORT_HISTORY_MAX_PAGE_SIZE),
)

// Same tuple-default workaround as the other query schemas (see common.ts).
export const SupportChatHistoryQuerySchema = type({
    // A row id that fits a bigint column: at most 18 digits, no leading zero.
    'before?': /^[1-9]\d{0,17}$/,
    limit: [
        historyLimitFromString,
        '=',
        String(SUPPORT_HISTORY_DEFAULT_PAGE_SIZE),
    ] as unknown as 'string.integer.parse',
}) as unknown as SharedQuerySchema<SupportChatHistoryQueryOutput>

export type SupportChatHistoryQuery = typeof SupportChatHistoryQuerySchema.infer
