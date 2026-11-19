import { EventEmitter } from 'node:events'
import type { Redis } from 'ioredis'
import type { Profile } from 'shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('#database/redis.js', () => ({ default: { publish: vi.fn() } }))
vi.mock('#app/services/communication/broadcast-service.js', () => ({
    broadcastService: { broadcastMessageToUser: vi.fn() },
}))

const { createUserEventBus, parseEnvelope } = await import('./user-event-bus.js')

// feat-232 (Р9 B): the user event bus with Redis replaced by a fake subscriber.

const PROFILE: Profile = {
    name: 'Ann',
    preferences: { locale: null, timeZone: null, theme: 'dark', colorTheme: null, fontSize: null },
    revision: '4',
}

class FakeSubscriber extends EventEmitter {
    subscribe = vi.fn(() => Promise.resolve(1))
    disconnect = vi.fn()
}

const setup = () => {
    const subscriber = new FakeSubscriber()
    const publish = vi.fn((_channel: string, _message: string) => Promise.resolve(1))
    const deliverLocally = vi.fn(() => 1)
    const bus = createUserEventBus({
        channel: 'test:user-events',
        publish,
        createSubscriber: () => subscriber as unknown as Redis,
        deliverLocally,
    })
    return { bus, subscriber, publish, deliverLocally }
}

afterEach(() => {
    vi.clearAllMocks()
})

describe('user event bus', () => {
    it('not started: the event reaches this process only', async () => {
        const { bus, publish, deliverLocally } = setup()

        await bus.publishToUser('7', 'user_profile_updated', PROFILE)

        expect(publish).not.toHaveBeenCalled()
        expect(deliverLocally).toHaveBeenCalledWith('7', 'user_profile_updated', PROFILE)
    })

    it('started: publishes the envelope and leaves delivery to the subscription', async () => {
        const { bus, subscriber, publish, deliverLocally } = setup()
        await bus.start()
        expect(subscriber.subscribe).toHaveBeenCalledWith('test:user-events')

        await bus.publishToUser('7', 'user_profile_updated', PROFILE)

        expect(publish).toHaveBeenCalledOnce()
        const [channel, raw] = publish.mock.calls[0]!
        expect(channel).toBe('test:user-events')
        expect(JSON.parse(raw)).toEqual({
            v: 1,
            userId: '7',
            event: 'user_profile_updated',
            payload: PROFILE,
        })
        expect(deliverLocally).not.toHaveBeenCalled()
    })

    it('a message of the channel is delivered to the connections of this process', async () => {
        const { bus, subscriber, deliverLocally } = setup()
        await bus.start()

        subscriber.emit(
            'message',
            'test:user-events',
            JSON.stringify({ v: 1, userId: '7', event: 'user_profile_updated', payload: PROFILE }),
        )

        expect(deliverLocally).toHaveBeenCalledWith('7', 'user_profile_updated', PROFILE)
    })

    it('another channel, a broken message and an event not allowed on the bus are dropped', async () => {
        const { bus, subscriber, deliverLocally } = setup()
        await bus.start()
        const valid = { v: 1, userId: '7', event: 'user_profile_updated', payload: PROFILE }

        subscriber.emit('message', 'other:user-events', JSON.stringify(valid))
        subscriber.emit('message', 'test:user-events', '{not json')
        subscriber.emit(
            'message',
            'test:user-events',
            JSON.stringify({ ...valid, event: 'support_chat_token' }),
        )
        subscriber.emit('message', 'test:user-events', JSON.stringify({ ...valid, userId: 'x' }))

        expect(deliverLocally).not.toHaveBeenCalled()
    })

    it('a failed publish still reaches this process', async () => {
        const { bus, publish, deliverLocally } = setup()
        await bus.start()
        publish.mockRejectedValueOnce(new Error('Redis down'))

        await bus.publishToUser('7', 'user_profile_updated', PROFILE)

        expect(deliverLocally).toHaveBeenCalledWith('7', 'user_profile_updated', PROFILE)
    })

    it('stop ends the subscription: later events go to this process only', async () => {
        const { bus, subscriber, publish, deliverLocally } = setup()
        await bus.start()
        await bus.stop()

        expect(subscriber.disconnect).toHaveBeenCalledOnce()
        await bus.publishToUser('7', 'user_profile_updated', PROFILE)
        expect(publish).not.toHaveBeenCalled()
        expect(deliverLocally).toHaveBeenCalledOnce()
    })

    it('parseEnvelope accepts only version 1 with a user id and a bus event', () => {
        expect(parseEnvelope('[]')).toBeNull()
        expect(
            parseEnvelope(JSON.stringify({ v: 2, userId: '7', event: 'user_profile_updated' })),
        ).toBeNull()
        expect(
            parseEnvelope(JSON.stringify({ v: 1, userId: '0', event: 'user_profile_updated' })),
        ).toBeNull()
        expect(
            parseEnvelope(
                JSON.stringify({ v: 1, userId: '42', event: 'user_profile_updated', payload: 1 }),
            ),
        ).toEqual({ v: 1, userId: '42', event: 'user_profile_updated', payload: 1 })
    })
})
