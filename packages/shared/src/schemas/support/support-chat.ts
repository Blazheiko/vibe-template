import { type } from '@arktype/type'
import { SUPPORT_MESSAGE_MAX_LENGTH } from '../../limits/index.js'

export const SupportChatInputSchema = type({
    message: type('string').atLeastLength(1).atMostLength(SUPPORT_MESSAGE_MAX_LENGTH),
    // UI locale (e.g. "uk", "pt-BR"); the server maps it to an app locale or its default.
    'language?': 'string <= 16',
    '+': 'reject',
})

export type SupportChatInput = typeof SupportChatInputSchema.infer
