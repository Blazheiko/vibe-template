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
        instanceId: 'self',
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

    it('started: delivers here at once and publishes the envelope for the other instances', async () => {
        const { bus, subscriber, publish, deliverLocally } = setup()
        await bus.start()
        expect(subscriber.subscribe).toHaveBeenCalledWith('test:user-events')

        await bus.publishToUser('7', 'user_profile_updated', PROFILE)

        expect(deliverLocally).toHaveBeenCalledExactlyOnceWith('7', 'user_profile_updated', PROFILE)
        expect(publish).toHaveBeenCalledOnce()
        const [channel, raw] = publish.mock.calls[0]!
        expect(channel).toBe('test:user-events')
        expect(JSON.parse(raw)).toEqual({
            v: 1,
            origin: 'self',
            userId: '7',
            event: 'user_profile_updated',
            payload: PROFILE,
        })
    })

    it('its own echo from Redis is skipped: one delivery per connection', async () => {
        const { bus, subscriber, publish, deliverLocally } = setup()
        await bus.start()
        await bus.publishToUser('7', 'user_profile_updated', PROFILE)

        subscriber.emit('message', 'test:user-events', publish.mock.calls[0]![1])

        expect(deliverLocally).toHaveBeenCalledOnce()
    })

    // Review 2026-11-19, item 6: the subscriber was set before SUBSCRIBE finished, so an event
    // published in that gap reached neither the subscription nor the local fallback.
    it('while SUBSCRIBE is still pending, the event reaches this process', async () => {
        const { bus, subscriber, deliverLocally } = setup()
        subscriber.subscribe.mockReturnValueOnce(new Promise(() => undefined))
        void bus.start()

        await bus.publishToUser('7', 'user_profile_updated', PROFILE)

        expect(deliverLocally).toHaveBeenCalledExactlyOnceWith('7', 'user_profile_updated', PROFILE)
    })

    it('a message of another instance is delivered to the connections of this process', async () => {
        const { bus, subscriber, deliverLocally } = setup()
        await bus.start()

        subscriber.emit(
            'message',
            'test:user-events',
            JSON.stringify({
                v: 1,
                origin: 'other',
                userId: '7',
                event: 'user_profile_updated',
                payload: PROFILE,
            }),
        )

        expect(deliverLocally).toHaveBeenCalledWith('7', 'user_profile_updated', PROFILE)
    })

    it('another channel, a broken message and an event not allowed on the bus are dropped', async () => {
        const { bus, subscriber, deliverLocally } = setup()
        await bus.start()
        const valid = {
            v: 1,
            origin: 'other',
            userId: '7',
            event: 'user_profile_updated',
            payload: PROFILE,
        }

        subscriber.emit('message', 'other:user-events', JSON.stringify(valid))
        subscriber.emit('message', 'test:user-events', '{not json')
        subscriber.emit(
            'message',
            'test:user-events',
            JSON.stringify({ ...valid, event: 'support_chat_token' }),
        )
        subscriber.emit('message', 'test:user-events', JSON.stringify({ ...valid, userId: 'x' }))
        subscriber.emit('message', 'test:user-events', JSON.stringify({ ...valid, origin: '' }))

        expect(deliverLocally).not.toHaveBeenCalled()
    })

    it('a failed publish still reaches this process, once', async () => {
        const { bus, publish, deliverLocally } = setup()
        await bus.start()
        publish.mockRejectedValueOnce(new Error('Redis down'))

        await bus.publishToUser('7', 'user_profile_updated', PROFILE)

        expect(deliverLocally).toHaveBeenCalledExactlyOnceWith('7', 'user_profile_updated', PROFILE)
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
            parseEnvelope(
                JSON.stringify({ v: 2, origin: 'a', userId: '7', event: 'user_profile_updated' }),
            ),
        ).toBeNull()
        expect(
            parseEnvelope(
                JSON.stringify({ v: 1, origin: 'a', userId: '0', event: 'user_profile_updated' }),
            ),
        ).toBeNull()
        // Without the instance that published it, an echo could not be told from another's.
        expect(
            parseEnvelope(
                JSON.stringify({ v: 1, userId: '42', event: 'user_profile_updated', payload: 1 }),
            ),
        ).toBeNull()
        const envelope = {
            v: 1,
            origin: 'a',
            userId: '42',
            event: 'user_profile_updated',
            payload: 1,
        }
        expect(parseEnvelope(JSON.stringify(envelope))).toEqual(envelope)
    })
})
