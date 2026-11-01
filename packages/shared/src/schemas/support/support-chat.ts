import { type } from '@arktype/type'
import { SUPPORT_MESSAGE_MAX_LENGTH } from '../../limits/index.js'

export const SupportChatInputSchema = type({
    message: type('string').atLeastLength(1).atMostLength(SUPPORT_MESSAGE_MAX_LENGTH),
    // UI locale (e.g. "uk", "pt-BR"); the server maps it to an app locale or its default.
    'language?': 'string <= 16',
    // Chosen by the client for each message and sent again unchanged when the answer to the
    // request was lost: the server stores a message once per id, so a resend cannot duplicate
    // it. The server echoes it on the events of the answer, so the client can tell them from
    // the events of another answer.
    'clientMessageId?': '/^[A-Za-z0-9_-]{1,64}$/',
    '+': 'reject',
})

export type SupportChatInput = typeof SupportChatInputSchema.infer
