import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema } from './error-response.js'

export const SupportChatResponseSchema = type.or(
    { status: "'ok'", 'message?': 'string' },
    CanonicalErrorResponseSchema,
)
export type SupportChatResponse = typeof SupportChatResponseSchema.infer

export const SupportOpenChatResponseSchema = type.or(
    { status: "'ok'", 'message?': 'string' },
    CanonicalErrorResponseSchema,
)
export type SupportOpenChatResponse = typeof SupportOpenChatResponseSchema.infer

// support-service.ts SupportChatHistoryItem.
export const SupportChatHistoryItemSchema = type({
    id: 'string',
    role: "'user' | 'assistant'",
    content: 'string',
    screenshots: 'string[] | null',
    createdAt: 'string',
})

export const SupportGetChatHistoryResponseSchema = type.or(
    {
        status: "'ok'",
        'message?': 'string',
        'data?': SupportChatHistoryItemSchema.array(),
        // True when there are messages older than the first of `data`.
        'hasMore?': 'boolean',
    },
    CanonicalErrorResponseSchema,
)
export type SupportGetChatHistoryResponse = typeof SupportGetChatHistoryResponseSchema.infer

export const SupportDeleteChatHistoryResponseSchema = type.or(
    { status: "'ok'", 'message?': 'string' },
    CanonicalErrorResponseSchema,
)
export type SupportDeleteChatHistoryResponse = typeof SupportDeleteChatHistoryResponseSchema.infer

// knowledge-base-service.ts KbItemData.
export const SupportKnowledgeBaseItemSchema = type({
    id: 'string',
    title: 'string',
    content: 'string',
    category: 'string | null',
    isActive: 'boolean',
    hasScreenshot: 'boolean',
    screenshotKey: 'string | null',
    embeddingIndexed: 'boolean',
    createdAt: 'string',
    updatedAt: 'string',
})

export const SupportKnowledgeBaseListResponseSchema = type.or(
    {
        status: "'ok'",
        'message?': 'string',
        'data?': SupportKnowledgeBaseItemSchema.array(),
        'total?': 'number',
    },
    CanonicalErrorResponseSchema,
)
export type SupportKnowledgeBaseListResponse = typeof SupportKnowledgeBaseListResponseSchema.infer

export const SupportKnowledgeBaseItemResponseSchema = type.or(
    { status: "'ok'", 'message?': 'string', 'data?': SupportKnowledgeBaseItemSchema },
    CanonicalErrorResponseSchema,
)
export type SupportKnowledgeBaseItemResponse = typeof SupportKnowledgeBaseItemResponseSchema.infer

// GET /support/screenshot/:articleId answers 302 with Location; the body only marks the
// redirect. feat-044 skips 3xx, so this schema is checked by TypeScript only.
export const SupportScreenshotResponseSchema = type.or(
    { status: "'redirect'" },
    CanonicalErrorResponseSchema,
)
export type SupportScreenshotResponse = typeof SupportScreenshotResponseSchema.infer

export const SupportKnowledgeBaseDeleteResponseSchema = type.or(
    { status: "'ok'", 'message?': 'string' },
    CanonicalErrorResponseSchema,
)
export type SupportKnowledgeBaseDeleteResponse =
    typeof SupportKnowledgeBaseDeleteResponseSchema.infer

export const SupportKnowledgeBaseReindexResponseSchema = type.or(
    { status: "'ok'", 'message?': 'string', 'indexed?': 'number' },
    CanonicalErrorResponseSchema,
)
export type SupportKnowledgeBaseReindexResponse =
    typeof SupportKnowledgeBaseReindexResponseSchema.infer

export const SupportKnowledgeBaseInitJobSchema = type({
    state: "'idle' | 'running' | 'completed' | 'failed'",
    totalFiles: 'number',
    processedFiles: 'number',
    createdArticles: 'number',
    failedFiles: 'number',
    progressPercent: 'number',
    currentFile: 'string | null',
    startedAt: 'string | null',
    completedAt: 'string | null',
    message: 'string | null',
})
export type SupportKnowledgeBaseInitJob = typeof SupportKnowledgeBaseInitJobSchema.infer

export const SupportKnowledgeBaseInitResponseSchema = type.or(
    { status: "'ok'", 'message?': 'string', 'data?': SupportKnowledgeBaseInitJobSchema },
    type.and(CanonicalErrorResponseSchema, { 'data?': SupportKnowledgeBaseInitJobSchema }),
)
export type SupportKnowledgeBaseInitResponse = typeof SupportKnowledgeBaseInitResponseSchema.infer
