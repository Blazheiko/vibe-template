import { isDeliveryUnknown } from '@/utils/websocket-types'

// Sending a support message when the answer to the request may be lost.
//
// The server stores a message once per client message id, so the same request can be sent
// again without duplicating the message. That is the only safe way to deal with a lost
// answer: looking for the message in the history proves nothing (the original may still be
// waiting for its INSERT), so its absence is never read as "not delivered".

export type SendResult =
    /** The server answered `ok`: the message is stored and being answered. */
    | { kind: 'accepted' }
    /** Nothing was stored: the server refused the first attempt, or it never left. */
    | { kind: 'refused'; error: unknown }
    /** An attempt got no answer and no later one was accepted: the message may be stored. */
    | { kind: 'unconfirmed'; error: unknown }

/** Sends once; if the answer is lost, sends the same request once more. */
export async function sendUntilAnswered(send: () => Promise<unknown>): Promise<SendResult> {
    try {
        await send()
        return { kind: 'accepted' }
    } catch (first) {
        if (!isDeliveryUnknown(first)) return { kind: 'refused', error: first }
    }
    try {
        await send()
        return { kind: 'accepted' }
    } catch (second) {
        // Even an explicit refusal of the resend (busy, rate limit) says nothing about the
        // original, which may be stored or still running.
        return { kind: 'unconfirmed', error: second }
    }
}

/**
 * Whether an event belongs to the message in flight. An event of another answer (an older
 * one that ran past its lock) must not end this one. Events without an id (the greeting) and
 * the case of nothing in flight (the page was reloaded during an answer) are accepted.
 */
export const isEventForRequest = (
    activeMessageId: string | undefined,
    eventMessageId: string | undefined,
): boolean =>
    activeMessageId === undefined ||
    eventMessageId === undefined ||
    activeMessageId === eventMessageId

/** The server accepts [A-Za-z0-9_-]{1,64}. */
export const newClientMessageId = (): string =>
    typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
