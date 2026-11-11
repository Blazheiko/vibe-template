import { type } from '@arktype/type'

// The bounds are the columns of `llm_system_prompts` and what a provider accepts (feat-161).
// Without them a fractional `maxTokens` or a long `model` reached the UPDATE and came back as a
// 500, and a negative `maxTokens` was stored and then made the daily budget reservation
// negative, which refused every user until midnight.
export const PromptUpdateInputSchema = type({
    'content?': 'string <= 50000',
    'model?': 'string <= 100 | null',
    // The range the providers document; a model may accept less.
    'temperature?': '0 <= number <= 2 | null',
    'maxTokens?': '1 <= number.integer <= 100000 | null',
    '+': 'reject',
})

export type PromptUpdateInput = typeof PromptUpdateInputSchema.infer
