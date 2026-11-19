import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import type { Profile } from 'shared'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasRedis, REDIS_TEST_URL } from '../../../test-support/redis-test-client.js'

vi.mock('#database/redis.js', () => ({ default: { publish: vi.fn() } }))
vi.mock('#app/services/communication/broadcast-service.js', () => ({
    broadcastService: { broadcastMessageToUser: vi.fn() },
}))

const { createUserEventBus } = await import('./user-event-bus.js')

// feat-232 (Р9 B): two backend instances on one real Redis. An event published by one reaches
// the connections held by both, the publishing one included.

const PROFILE: Profile = {
    name: 'Ann',
    preferences: { locale: 'uk', timeZone: null, theme: 'dark', colorTheme: null, fontSize: 18 },
    revision: '9',
}

const url = REDIS_TEST_URL ?? 'redis://127.0.0.1:6379'
const clients: Redis[] = []
const client = (): Redis => {
    const created = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1 })
    clients.push(created)
    return created
}

const instance = (channel: string) => {
    const delivered: unknown[][] = []
    const publisher = client()
    const bus = createUserEventBus({
        channel,
        publish: (name, message) => publisher.publish(name, message),
        createSubscriber: () => new Redis(url, { lazyConnect: false }),
        deliverLocally: (...args) => {
            delivered.push(args)
            return 1
        },
    })
    return { bus, delivered }
}

afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()))
})

describe.skipIf(!hasRedis)('user event bus across instances', () => {
    it('an event of instance A reaches the connections of A and of B', async () => {
        const channel = `test:${randomUUID()}:user-events`
        const a = instance(channel)
        const b = instance(channel)
        await a.bus.start()
        await b.bus.start()

        await a.bus.publishToUser('7', 'user_profile_updated', PROFILE)

        await vi.waitFor(() => {
            expect(a.delivered).toEqual([['7', 'user_profile_updated', PROFILE]])
            expect(b.delivered).toEqual([['7', 'user_profile_updated', PROFILE]])
        })
        await a.bus.stop()
        await b.bus.stop()
    })

    it('a deployment with another prefix (channel) does not get the event', async () => {
        const a = instance(`test:${randomUUID()}:user-events`)
        const other = instance(`test:${randomUUID()}:user-events`)
        await a.bus.start()
        await other.bus.start()

        await a.bus.publishToUser('7', 'user_profile_updated', PROFILE)

        await vi.waitFor(() => {
            expect(a.delivered).toHaveLength(1)
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(other.delivered).toEqual([])
        await a.bus.stop()
        await other.bus.stop()
    })
})
