import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BroadcastEventName } from 'shared/contracts'

import type { BroadcastGuards } from '@/utils/ws-payload-guards'
import type { WsBroadcastEnvelope } from 'shared/ws-client'

// feat-182 (ADR 0006, decision 3): a broadcast event of the server reaches the event bus under its
// own name with the payload of its contract, once its guard accepted it.

const emit = vi.hoisted(() => vi.fn())
vi.mock('@/utils/event-bus', () => ({ useEventBus: () => ({ emit }) }))
const reportValidationFailure = vi.hoisted(() => vi.fn())
vi.mock('@/utils/sentry-payload-summary', () => ({ reportValidationFailure }))

const { useBroadcastHandler } = await import('../useBroadcastHandler')

const valid: Record<BroadcastEventName, Record<string, unknown>> = {
    support_chat_token: { token: 'Hel', clientMessageId: 'c-1' },
    support_chat_complete: { content: 'Hello', screenshots: ['1'] },
    support_chat_error: { message: 'failed', code: 'chat_failed' },
    admin_user_online_upsert: {
        id: '42',
        name: 'Ada',
        email: 'ada@example.test',
        appType: 'pwa',
        userAgent: 'Mozilla/5.0',
        connectionsCount: 2,
    },
    admin_user_online_remove: { id: '42' },
}

const broadcast = (event: string, payload: unknown): WsBroadcastEnvelope => ({
    event: `broadcast:${event}`,
    status: 200,
    payload,
})

beforeEach(() => {
    vi.clearAllMocks()
})

describe('useBroadcastHandler', () => {
    it.each(Object.keys(valid) as BroadcastEventName[])(
        'hands %s to the event bus with its payload',
        (event) => {
            useBroadcastHandler().handleBroadcast(broadcast(event, valid[event]))

            expect(emit).toHaveBeenCalledWith(event, valid[event])
            expect(reportValidationFailure).not.toHaveBeenCalled()
        },
    )

    it('reports and drops a payload its guard refuses', () => {
        useBroadcastHandler().handleBroadcast(broadcast('support_chat_token', { token: 7 }))

        expect(emit).not.toHaveBeenCalled()
        expect(reportValidationFailure).toHaveBeenCalledWith(
            'support_chat_token',
            'payload_shape',
            { token: 7 },
        )
    })

    it('ignores an event the contract does not name, an inherited key included', () => {
        const handler = useBroadcastHandler()
        handler.handleBroadcast(broadcast('something_else', {}))
        handler.handleBroadcast(broadcast('constructor', {}))

        expect(emit).not.toHaveBeenCalled()
        expect(reportValidationFailure).not.toHaveBeenCalled()
    })
})

// Compiled by vue-tsc, never run: the guard registry has to name every broadcast event.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function typeChecks(guard: (value: unknown) => boolean): void {
    // @ts-expect-error — a broadcast event without a guard
    const incomplete: BroadcastGuards = {
        support_chat_token: guard as BroadcastGuards['support_chat_token'],
    }
    console.log(incomplete)
}
