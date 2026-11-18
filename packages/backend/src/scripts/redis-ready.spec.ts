import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { waitForRedisReady } from './redis-ready.js'

class FakeClient extends EventEmitter {
    status = 'connecting'
}

afterEach(() => {
    vi.useRealTimers()
})

describe('waitForRedisReady', () => {
    it('resolves at once when the client is ready', async () => {
        const client = new FakeClient()
        client.status = 'ready'

        await expect(waitForRedisReady(client)).resolves.toBeUndefined()
    })

    it('waits for the ready event', async () => {
        const client = new FakeClient()
        const waiting = waitForRedisReady(client)

        client.status = 'ready'
        client.emit('ready')

        await expect(waiting).resolves.toBeUndefined()
    })

    it('gives up after the timeout and leaves no listener behind', async () => {
        vi.useFakeTimers()
        const client = new FakeClient()
        const waiting = waitForRedisReady(client, 1_000)
        const assertion = expect(waiting).rejects.toThrow('within 1000 ms')

        await vi.advanceTimersByTimeAsync(1_000)

        await assertion
        expect(client.listenerCount('ready')).toBe(0)
    })
})
