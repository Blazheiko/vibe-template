import { describe, expect, it } from 'vitest'

import { WS_RETRY_DELAY_MS, resolveWebSocketCloseAction } from '../websocket-close'

describe('resolveWebSocketCloseAction', () => {
    it('refreshes the token at once on 4001, opened or not', () => {
        expect(resolveWebSocketCloseAction(4001, true, 0)).toEqual({
            kind: 'refresh-token',
            delayMs: 0,
        })
        expect(resolveWebSocketCloseAction(4001, false, 3)).toEqual({
            kind: 'refresh-token',
            delayMs: 0,
        })
    })

    it('refreshes the token at once after the first failed handshake (401 at upgrade)', () => {
        expect(resolveWebSocketCloseAction(1006, false, 1)).toEqual({
            kind: 'refresh-token',
            delayMs: 0,
        })
    })

    it('waits before refreshing again when handshakes keep failing', () => {
        expect(resolveWebSocketCloseAction(1006, false, 2)).toEqual({
            kind: 'refresh-token',
            delayMs: WS_RETRY_DELAY_MS,
        })
    })

    it('reconnects after a delay when an open connection dropped', () => {
        expect(resolveWebSocketCloseAction(1006, true, 0)).toEqual({
            kind: 'reconnect',
            delayMs: WS_RETRY_DELAY_MS,
        })
        expect(resolveWebSocketCloseAction(1001, true, 0)).toEqual({
            kind: 'reconnect',
            delayMs: WS_RETRY_DELAY_MS,
        })
    })

    it('stops on other application codes 4000-4099', () => {
        expect(resolveWebSocketCloseAction(4000, true, 0)).toEqual({ kind: 'stop' })
        expect(resolveWebSocketCloseAction(4099, false, 0)).toEqual({ kind: 'stop' })
    })

    // feat-149: the backend closes a connection that keeps going over its message budget.
    it('does not reconnect after 4029 (message budget exceeded)', () => {
        expect(resolveWebSocketCloseAction(4029, true, 0)).toEqual({ kind: 'stop' })
    })
})
