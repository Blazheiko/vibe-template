import { describe, expect, it, vi } from 'vitest'

import { isEventForRequest, newClientMessageId, sendUntilAnswered } from '../support-send'
import { WsDeliveryUnknownError, buildApiError } from '../websocket-types'

const refusal = () =>
    buildApiError({
        event: 'api/support/support_chat',
        status: '429',
        timestamp: 1,
        payload: {},
        code: 'rate_limited',
        error: { code: 'rate_limited', message: 'Too many messages.' },
    })
const lost = () => new WsDeliveryUnknownError('Request timeout')

// The send carries one client message id, so sending it again cannot duplicate the message:
// the server stores a message once per id. That is what makes the resend safe, and why a
// missing message in the history is never taken as proof that it was not delivered.
describe('sendUntilAnswered', () => {
    it('is accepted at once when the first attempt is answered', async () => {
        const send = vi.fn().mockResolvedValue({ status: 'ok' })

        expect(await sendUntilAnswered(send)).toEqual({ kind: 'accepted' })
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('is refused, with no resend, when the server explicitly refuses', async () => {
        const error = refusal()
        const send = vi.fn().mockRejectedValue(error)

        expect(await sendUntilAnswered(send)).toEqual({ kind: 'refused', error })
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('is refused when the message could not be sent at all', async () => {
        const error = new Error('WebSocket not connected')
        const send = vi.fn().mockRejectedValue(error)

        expect(await sendUntilAnswered(send)).toEqual({ kind: 'refused', error })
    })

    it('sends the same request again when the answer was lost, and is accepted if that is answered', async () => {
        const send = vi.fn().mockRejectedValueOnce(lost()).mockResolvedValueOnce({ status: 'ok' })

        expect(await sendUntilAnswered(send)).toEqual({ kind: 'accepted' })
        expect(send).toHaveBeenCalledTimes(2)
    })

    // The original may still be running or stored: a refusal of the resend (busy, rate
    // limit) proves nothing about it, so it is not "refused" and the message stays.
    it('is unconfirmed, not refused, when the resend is refused after a lost answer', async () => {
        const error = refusal()
        const send = vi.fn().mockRejectedValueOnce(lost()).mockRejectedValueOnce(error)

        expect(await sendUntilAnswered(send)).toEqual({ kind: 'unconfirmed', error })
    })

    it('is unconfirmed when the resend is lost too, and does not try a third time', async () => {
        const send = vi.fn().mockRejectedValue(lost())

        expect((await sendUntilAnswered(send)).kind).toBe('unconfirmed')
        expect(send).toHaveBeenCalledTimes(2)
    })
})

describe('isEventForRequest', () => {
    it('accepts the event of the request in flight', () => {
        expect(isEventForRequest('a', 'a')).toBe(true)
    })

    it('rejects the event of another request', () => {
        expect(isEventForRequest('a', 'b')).toBe(false)
    })

    it('accepts an event with no id (the greeting) and any event when nothing is in flight', () => {
        expect(isEventForRequest('a', undefined)).toBe(true)
        expect(isEventForRequest(undefined, 'b')).toBe(true)
        expect(isEventForRequest(undefined, undefined)).toBe(true)
    })
})

describe('newClientMessageId', () => {
    it('makes ids the server accepts, different every time', () => {
        const ids = Array.from({ length: 50 }, () => newClientMessageId())

        for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
        expect(new Set(ids).size).toBe(50)
    })
})
