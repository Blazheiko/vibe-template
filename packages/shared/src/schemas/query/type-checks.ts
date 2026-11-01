import type {
    AdminKnowledgeBaseListQuery,
    AdminOnlineHistoryListQuery,
    AdminUserListQuery,
} from './admin.js'
import type { SupportChatHistoryQuery } from './support.js'
import type { LlmTextUsageQuery } from './usage.js'
import type { AssertEqual, Expect } from './types.js'

// What each query schema infers is what the callers of the API are told, so it is written out here
// and compared with the schema at compile time: a change of the schema that changes what a
// handler receives (a default dropped, a number that becomes a string) stops the build. Nothing
// imports this file; it exists to be compiled.

export type QueryOutputChecks = [
    Expect<
        AssertEqual<
            AdminUserListQuery,
            { userId?: string; limit: number; dateFrom?: Date; dateTo?: Date }
        >
    >,
    Expect<
        AssertEqual<
            AdminOnlineHistoryListQuery,
            { userId?: string; cursor?: string; limit: number; dateFrom?: Date; dateTo?: Date }
        >
    >,
    Expect<
        AssertEqual<AdminKnowledgeBaseListQuery, { category?: string; page: number; limit: number }>
    >,
    Expect<
        AssertEqual<
            LlmTextUsageQuery,
            {
                page: number
                limit: number
                userId?: string
                dateFrom?: Date
                dateTo?: Date
                feature?:
                    | 'SUPPORT_CHAT'
                    | 'SUPPORT_QUERY_TRANSLATION'
                    | 'PROMPT_TEST'
                    | 'SUPPORT_EMBEDDING'
            }
        >
    >,
    Expect<AssertEqual<SupportChatHistoryQuery, { before?: string; limit: number }>>,
]
