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
    const handled: [string, string][] = []
    bus.handleServerEvents((event, userId) => {
        handled.push([event, userId])
    })
    return { bus, delivered, handled }
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

    // feat-236 (Р8): the notification signals cross instances like the profile event.
    it.each(['notifications_changed', 'notification_preferences_changed'] as const)(
        '%s of instance A reaches B',
        async (event) => {
            const channel = `test:${randomUUID()}:user-events`
            const a = instance(channel)
            const b = instance(channel)
            await a.bus.start()
            await b.bus.start()

            await a.bus.publishToUser('7', event, {})

            await vi.waitFor(() => {
                expect(b.delivered).toEqual([['7', event, {}]])
            })
            await a.bus.stop()
            await b.bus.stop()
        },
    )

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

    // feat-240 (Р8): a role change is an event for the instances, never for a client.
    it('user_role_changed of instance A runs the handler of A and of B and reaches no client', async () => {
        const channel = `test:${randomUUID()}:user-events`
        const a = instance(channel)
        const b = instance(channel)
        await a.bus.start()
        await b.bus.start()

        await a.bus.notifyServer('7', 'user_role_changed')

        await vi.waitFor(() => {
            expect(a.handled).toEqual([['user_role_changed', '7']])
            expect(b.handled).toEqual([['user_role_changed', '7']])
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(a.handled).toHaveLength(1)
        expect(a.delivered).toEqual([])
        expect(b.delivered).toEqual([])
        await a.bus.stop()
        await b.bus.stop()
    })

    it('publishRemote reaches a started instance from a process that never started its bus', async () => {
        const channel = `test:${randomUUID()}:user-events`
        const cli = instance(channel)
        const server = instance(channel)
        await server.bus.start()

        await cli.bus.publishRemote('8', 'user_role_changed')

        await vi.waitFor(() => {
            expect(server.handled).toEqual([['user_role_changed', '8']])
        })
        expect(cli.handled).toEqual([])
        await server.bus.stop()
    })
})
