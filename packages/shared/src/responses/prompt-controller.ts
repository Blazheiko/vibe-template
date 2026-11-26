import { type } from '@arktype/type'
import { EntityIdSchema } from '../brands/ids.js'
import { IsoDateTimeSchema } from '../brands/wire.js'
import { CanonicalErrorResponseSchema } from './error-response.js'

// prompt-transformer.ts SerializedPrompt: a llm_system_prompts row as the client gets it.
export const PromptRowSchema = type({
    id: EntityIdSchema,
    type: "'SUPPORT_SYSTEM' | 'SUPPORT_FIRST_CHAT' | 'SUPPORT_QUERY_TRANSLATION'",
    topic: 'string | null',
    content: 'string',
    model: 'string | null',
    temperature: 'number | null',
    maxTokens: 'number | null',
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
})
export type PromptRowResponse = typeof PromptRowSchema.infer

export const PromptGetListResponseSchema = type.or(
    { status: "'success'", 'message?': 'string', 'data?': PromptRowSchema.array() },
    CanonicalErrorResponseSchema,
)
export type PromptGetListResponse = typeof PromptGetListResponseSchema.infer

export const PromptGetByTypeResponseSchema = type.or(
    { status: "'success'", 'message?': 'string', 'data?': PromptRowSchema },
    CanonicalErrorResponseSchema,
)
export type PromptGetByTypeResponse = typeof PromptGetByTypeResponseSchema.infer

export const PromptUpdateResponseSchema = type.or(
    { status: "'success'", 'message?': 'string' },
    CanonicalErrorResponseSchema,
)
export type PromptUpdateResponse = typeof PromptUpdateResponseSchema.infer

export const PromptTestResponseSchema = type.or(
    { status: "'success'", 'message?': 'string', 'result?': 'string' },
    CanonicalErrorResponseSchema,
)
export type PromptTestResponse = typeof PromptTestResponseSchema.infer
