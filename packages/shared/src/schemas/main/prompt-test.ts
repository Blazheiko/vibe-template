import { type } from '@arktype/type'

export const PromptTestInputSchema = type({
    // As long as a support message may be (SUPPORT_MESSAGE_MAX_LENGTH).
    message: '1 <= string <= 4000',
    '+': 'reject',
})

export type PromptTestInput = typeof PromptTestInputSchema.infer
