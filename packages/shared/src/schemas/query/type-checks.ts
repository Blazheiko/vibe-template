import type {
    AdminKnowledgeBaseListQuery,
    AdminKnowledgeBaseListQueryInput,
    AdminOnlineHistoryListQuery,
    AdminOnlineHistoryListQueryInput,
    AdminUserListQuery,
    AdminUserListQueryInput,
} from './admin.js'
import type {
    AdminUserSearchQueryInput,
    OAuthCallbackQueryInput,
    OAuthRedirectQueryInput,
} from './simple.js'
import type { SupportChatHistoryQuery, SupportChatHistoryQueryInput } from './support.js'
import type { LlmTextUsageQuery, LlmTextUsageQueryInput } from './usage.js'
import type { AssertEqual, Expect } from './types.js'

// What each query schema infers is what the callers of the API are told, so it is written out here
// and compared with the schema at compile time: a change of the schema that changes what a
// handler receives (a default dropped, a number that becomes a string) stops the build. Nothing
// imports this file; it exists to be compiled.

export type QueryOutputChecks = [
    Expect<
        AssertEqual<
            AdminUserListQuery,
            { userId?: string; cursor?: string; limit: number; dateFrom?: Date; dateTo?: Date }
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

type Feature = 'SUPPORT_CHAT' | 'SUPPORT_QUERY_TRANSLATION' | 'PROMPT_TEST' | 'SUPPORT_EMBEDDING'

// What a client sends, derived from the same schemas by `QueryInputOf` (feat-183): every key with
// a default or a `?` is optional, a parsed number may go as a number or its text, a date as text.
// These are the types the client side was written against before they were derived.
export type QueryInputChecks = [
    Expect<
        AssertEqual<
            AdminUserListQueryInput,
            {
                userId?: string
                cursor?: string
                limit?: number | string
                dateFrom?: string
                dateTo?: string
            }
        >
    >,
    Expect<AssertEqual<AdminOnlineHistoryListQueryInput, AdminUserListQueryInput>>,
    Expect<
        AssertEqual<
            AdminKnowledgeBaseListQueryInput,
            { category?: string; page?: number | string; limit?: number | string }
        >
    >,
    Expect<
        AssertEqual<
            LlmTextUsageQueryInput,
            {
                page?: number | string
                limit?: number | string
                userId?: string
                dateFrom?: string
                dateTo?: string
                feature?: Feature
            }
        >
    >,
    Expect<AssertEqual<SupportChatHistoryQueryInput, { before?: string; limit?: number | string }>>,
    Expect<AssertEqual<AdminUserSearchQueryInput, { email: string }>>,
    // `type({})` infers `object`: the route takes no query.
    Expect<AssertEqual<OAuthRedirectQueryInput, object>>,
    Expect<AssertEqual<OAuthCallbackQueryInput, { code?: string; state?: string }>>,
]
