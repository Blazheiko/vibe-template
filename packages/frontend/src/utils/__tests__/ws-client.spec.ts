import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adminWsContracts, pushSubscriptionContracts, supportWsContracts } from 'shared/contracts'

// feat-181 (ADR 0006): a WS request goes through its contract. `callWs` hands the event (the
// contract path without its leading slash; the connection adds the API prefix) and the payload
// to the connection, and settles as the connection does.

const websocketApi = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi }),
}))

const { callWs } = await import('../ws-client')

beforeEach(() => {
    websocketApi.mockReset()
    websocketApi.mockResolvedValue({ event: 'x', status: '200', data: { status: 'ok' } })
})

describe('callWs', () => {
    it('sends the event of the contract and its payload', async () => {
        const payload = { message: 'hi', language: 'en', clientMessageId: 'c-1' }

        await callWs(supportWsContracts.chat, payload)

        expect(websocketApi).toHaveBeenCalledWith('support/support_chat', payload)
    })

    it('sends an empty payload for a contract without one', async () => {
        await callWs(adminWsContracts.subscribeOnlineUsers)

        expect(websocketApi).toHaveBeenCalledWith('admin/subscribe_online_users', {})
    })

    it('resolves with the reply, a business error included', async () => {
        const reply = { event: 'x', status: '200', data: { status: 'error', code: 'forbidden' } }
        websocketApi.mockResolvedValue(reply)

        await expect(callWs(adminWsContracts.subscribeOnlineUsers)).resolves.toBe(reply)
    })

    it('rejects as the connection does: a transport error or a timeout', async () => {
        const failure = new Error('Request timeout')
        websocketApi.mockRejectedValue(failure)

        await expect(callWs(supportWsContracts.openChat, { language: 'en' })).rejects.toBe(failure)
    })
})

// Compiled by vue-tsc, never run.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function typeChecks(): Promise<void> {
    // @ts-expect-error — the payload is required
    await callWs(supportWsContracts.chat)
    // @ts-expect-error — a field of another request
    await callWs(supportWsContracts.chat, { title: 'x' })
    // @ts-expect-error — an HTTP contract does not go over the socket
    await callWs(pushSubscriptionContracts.list)

    const reply = await callWs(adminWsContracts.subscribeOnlineUsers)
    // @ts-expect-error — the reply of this request has no such field
    console.log(reply.data?.notes)
}
