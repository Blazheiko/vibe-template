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

    // Review 2026-11-21: an event during a subscribe in flight is not lost.
    const deferred = () => {
        const state = { generation: 1, wanted: true }
        const answers: ((ok: boolean) => void)[] = []
        const subscribe = vi.fn(
            () =>
                new Promise<boolean>((resolve) => {
                    answers.push(resolve)
                }),
        )
        const onResumed = vi.fn()
        const channel = createAdminChannel({
            subscribe,
            unsubscribe: vi.fn(() => Promise.resolve()),
            generation: () => state.generation,
            wanted: () => state.wanted,
            onResumed,
        })
        return { state, answers, subscribe, onResumed, channel }
    }

    it('access_changed during a subscribe that then answers 403 subscribes once more', async () => {
        const { answers, subscribe, channel } = deferred()
        const first = channel.ensure()
        const second = channel.onAccessChanged()
        await second
        expect(subscribe).toHaveBeenCalledTimes(1)

        answers[0]?.(false)
        await vi.waitFor(() => {
            expect(subscribe).toHaveBeenCalledTimes(2)
        })
        answers[1]?.(true)
        await first

        expect(channel.isConfirmed()).toBe(true)
    })

    it('admin_channel_ready during a subscribe: its answer confirms nothing, the retry does', async () => {
        const { answers, subscribe, onResumed, channel } = deferred()
        const first = channel.ensure()
        void channel.onChannelReady()

        answers[0]?.(true)
        await vi.waitFor(() => {
            expect(subscribe).toHaveBeenCalledTimes(2)
        })
        expect(channel.isConfirmed()).toBe(false)
        expect(onResumed).not.toHaveBeenCalled()

        answers[1]?.(true)
        await first
        expect(channel.isConfirmed()).toBe(true)
        expect(onResumed).toHaveBeenCalledTimes(1)
    })

    it('does not retry when the subscribe in flight confirms the channel', async () => {
        const { answers, subscribe, channel } = deferred()
        const first = channel.ensure()
        void channel.onAccessChanged()
        answers[0]?.(true)
        await first
        expect(subscribe).toHaveBeenCalledTimes(1)
        expect(channel.isConfirmed()).toBe(true)
    })

    // feat-243 (second review): the permission goes and comes back on the same socket while the
    // first subscribe is in flight; its answer comes after the unsubscribe.
    it('an answer to a subscribe sent before leaving confirms nothing; the retry waits for the unsubscribe', async () => {
        const state = { generation: 1, wanted: true }
        const subscribes: ((ok: boolean) => void)[] = []
        const unsubscribes: (() => void)[] = []
        const order: string[] = []
        const channel = createAdminChannel({
            subscribe: vi.fn(
                () =>
                    new Promise<boolean>((resolve) => {
                        order.push('subscribe')
                        subscribes.push(resolve)
                    }),
            ),
            unsubscribe: vi.fn(
                () =>
                    new Promise<void>((resolve) => {
                        order.push('unsubscribe')
                        unsubscribes.push(resolve)
                    }),
            ),
            generation: () => state.generation,
            wanted: () => state.wanted,
            onResumed: vi.fn(),
        })

        const first = channel.ensure()
        state.wanted = false
        const left = channel.leave()
        state.wanted = true
        void channel.ensure()

        // The first answer arrives after the unsubscribe was sent: it is stale.
        subscribes[0]?.(true)
        await Promise.resolve()
        expect(channel.isConfirmed()).toBe(false)
        // The retry waits for the unsubscribe.
        expect(order).toEqual(['subscribe', 'unsubscribe'])

        unsubscribes[0]?.()
        await left
        await vi.waitFor(() => {
            expect(order).toEqual(['subscribe', 'unsubscribe', 'subscribe'])
        })
        subscribes[1]?.(true)
        await first

        expect(channel.isConfirmed()).toBe(true)
    })

    it('a subscribe asked for during an unsubscribe is sent after it', async () => {
        const order: string[] = []
        let finishUnsubscribe: () => void = () => undefined
        const channel = createAdminChannel({
            subscribe: vi.fn(() => {
                order.push('subscribe')
                return Promise.resolve(true)
            }),
            unsubscribe: vi.fn(
                () =>
                    new Promise<void>((resolve) => {
                        order.push('unsubscribe')
                        finishUnsubscribe = resolve
                    }),
            ),
            generation: () => 1,
            wanted: () => true,
            onResumed: vi.fn(),
        })

        const left = channel.leave()
        const subscribed = channel.ensure()
        await Promise.resolve()
        expect(order).toEqual(['unsubscribe'])

        finishUnsubscribe()
        await left
        await subscribed
        expect(order).toEqual(['unsubscribe', 'subscribe'])
        expect(channel.isConfirmed()).toBe(true)
    })

    // feat-244 (review 2026-11-21): access_changed and the permission watcher both leave; the
    // second unsubscribe would finish first and the subscribe sent after it be undone by the other.
    it('a second leave of the same socket joins the unsubscribe still running', async () => {
        const state = { generation: 1, wanted: false }
        const unsubscribes: (() => void)[] = []
        const order: string[] = []
        const channel = createAdminChannel({
            subscribe: vi.fn(() => {
                order.push('subscribe')
                return Promise.resolve(true)
            }),
            unsubscribe: vi.fn(
                () =>
                    new Promise<void>((resolve) => {
                        order.push('unsubscribe')
                        unsubscribes.push(resolve)
                    }),
            ),
            generation: () => state.generation,
            wanted: () => state.wanted,
            onResumed: vi.fn(),
        })

        const first = channel.leave()
        const second = channel.leave()
        expect(order).toEqual(['unsubscribe'])

        state.wanted = true
        const subscribed = channel.ensure()
        await Promise.resolve()
        expect(order).toEqual(['unsubscribe'])

        unsubscribes[0]?.()
        await Promise.all([first, second, subscribed])
        expect(order).toEqual(['unsubscribe', 'subscribe'])
        expect(channel.isConfirmed()).toBe(true)
    })

    it('a leave on a new socket sends its own unsubscribe', async () => {
        const state = { generation: 1, wanted: false }
        const unsubscribes: (() => void)[] = []
        const unsubscribe = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    unsubscribes.push(resolve)
                }),
        )
        const channel = createAdminChannel({
            subscribe: vi.fn(() => Promise.resolve(true)),
            unsubscribe,
            generation: () => state.generation,
            wanted: () => state.wanted,
            onResumed: vi.fn(),
        })

        const first = channel.leave()
        state.generation = 2
        const second = channel.leave()
        expect(unsubscribe).toHaveBeenCalledTimes(2)
        for (const resolve of unsubscribes) resolve()
        await Promise.all([first, second])
    })
})
