import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/ws-client', () => ({ callWs: vi.fn() }))

const { createAdminChannel } = await import('../useAdminChannel')

// feat-240 (Р8, Р10): the admin channel subscription is confirmed per socket.

const setup = (answers: boolean[] = []) => {
    const state = { generation: 1, wanted: true }
    const subscribe = vi.fn(() => Promise.resolve(answers.shift() ?? true))
    const unsubscribe = vi.fn(() => Promise.resolve())
    const onResumed = vi.fn()
    const channel = createAdminChannel({
        subscribe,
        unsubscribe,
        generation: () => state.generation,
        wanted: () => state.wanted,
        onResumed,
    })
    return { state, subscribe, unsubscribe, onResumed, channel }
}

describe('admin channel', () => {
    it('subscribes once per socket while wanted', async () => {
        const { channel, subscribe } = setup()
        await channel.ensure()
        await channel.ensure()
        expect(subscribe).toHaveBeenCalledTimes(1)
        expect(channel.isConfirmed()).toBe(true)
    })

    it('leaves a 403 unconfirmed, with no retry loop, and tries again on access_changed with the same role', async () => {
        const { channel, subscribe } = setup([false, true])
        await channel.ensure()
        expect(channel.isConfirmed()).toBe(false)
        expect(subscribe).toHaveBeenCalledTimes(1)

        await channel.onAccessChanged()

        expect(subscribe).toHaveBeenCalledTimes(2)
        expect(channel.isConfirmed()).toBe(true)
    })

    it('subscribes again on a new socket (ws_ready after a reconnect with the same role)', async () => {
        const { channel, subscribe, state } = setup()
        await channel.ensure()
        state.generation = 2
        expect(channel.isConfirmed()).toBe(false)

        await channel.ensure()

        expect(subscribe).toHaveBeenCalledTimes(2)
        expect(channel.isConfirmed()).toBe(true)
    })

    it('drops the answer of a socket that is gone', async () => {
        const { state, unsubscribe } = setup()
        let answer: (ok: boolean) => void = () => undefined
        const channel = createAdminChannel({
            subscribe: () =>
                new Promise<boolean>((resolve) => {
                    answer = resolve
                }),
            unsubscribe,
            generation: () => state.generation,
            wanted: () => state.wanted,
            onResumed: vi.fn(),
        })
        const pending = channel.ensure()
        state.generation = 2
        answer(true)
        await pending
        expect(channel.isConfirmed()).toBe(false)
    })

    it('a paused channel: admin_channel_ready clears the confirmation of the same socket, subscribes and reloads', async () => {
        const { channel, subscribe, onResumed } = setup()
        await channel.ensure()
        expect(channel.isConfirmed()).toBe(true)

        await channel.onChannelReady()

        expect(subscribe).toHaveBeenCalledTimes(2)
        expect(channel.isConfirmed()).toBe(true)
        expect(onResumed).toHaveBeenCalledTimes(1)
    })

    it('does not subscribe on admin_channel_ready once the admin area is left', async () => {
        const { channel, subscribe, unsubscribe, state, onResumed } = setup()
        await channel.ensure()
        state.wanted = false
        await channel.leave()

        await channel.onChannelReady()

        expect(unsubscribe).toHaveBeenCalledTimes(1)
        expect(subscribe).toHaveBeenCalledTimes(1)
        expect(onResumed).not.toHaveBeenCalled()
    })

    it('leaves the channel when access_changed takes users.read away', async () => {
        const { channel, unsubscribe, state } = setup()
        await channel.ensure()
        state.wanted = false

        await channel.onAccessChanged()

        expect(unsubscribe).toHaveBeenCalledTimes(1)
        expect(channel.isConfirmed()).toBe(false)
    })
})
