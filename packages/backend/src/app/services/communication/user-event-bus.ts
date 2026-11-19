import { Redis } from 'ioredis'
import logger from '#vendor/utils/logger.js'
import redisConfig from '#config/redis.js'
import publisherClient from '#database/redis.js'
import { mainRedisOptions } from '#database/redis-main-options.js'
import { broadcastService } from '#app/services/communication/broadcast-service.js'
import type { BroadcastEventName, BroadcastMessage } from 'shared/schemas'

/**
 * Events for every connection of a user, whichever backend instance holds it (feat-232, Р9 B).
 * `broadcastService.broadcastMessageToUser` reaches only the connections of this process, so an
 * event goes through Redis pub/sub: the instance that has it publishes it on one channel, every
 * instance (this one included) is subscribed and delivers it to its own connections.
 *
 * Delivery is best effort, as any broadcast: an event published while an instance is not
 * subscribed is not replayed. The client re-reads the state it shows after a reconnect.
 * When the publish fails (Redis down), the event still reaches the connections of this process.
 */

/** The events allowed on the bus; others go through `broadcastService` of their instance. */
const BUS_EVENTS: ReadonlySet<BroadcastEventName> = new Set(['user_profile_updated'])

interface BusEnvelope {
    v: 1
    userId: string
    event: BroadcastEventName
    payload: unknown
}

const USER_ID = /^[1-9]\d{0,19}$/

export const parseEnvelope = (raw: string): BusEnvelope | null => {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        return null
    }
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    if (record['v'] !== 1) return null
    const { userId, event } = record
    if (typeof userId !== 'string' || !USER_ID.test(userId)) return null
    if (typeof event !== 'string' || !BUS_EVENTS.has(event as BroadcastEventName)) return null
    return { v: 1, userId, event: event as BroadcastEventName, payload: record['payload'] }
}

export interface UserEventBusDeps {
    channel: string
    publish(channel: string, message: string): Promise<unknown>
    createSubscriber(): Redis
    /** Delivers to the connections of this process; returns how many got it. */
    deliverLocally(userId: string, ...message: BroadcastMessage): number
}

export interface UserEventBus {
    start(): Promise<void>
    stop(): Promise<void>
    /** Publishes to every instance; resolves once published (or delivered locally on failure). */
    publishToUser(userId: string, ...message: BroadcastMessage): Promise<void>
}

export function createUserEventBus(deps: UserEventBusDeps): UserEventBus {
    let subscriber: Redis | null = null

    const onMessage = (channel: string, raw: string): void => {
        if (channel !== deps.channel) return
        const envelope = parseEnvelope(raw)
        if (envelope === null) {
            logger.warn({ channel }, 'User event bus: message dropped, not a known event')
            return
        }
        // The payload is checked against the event schema by the broadcast service.
        deps.deliverLocally(
            envelope.userId,
            ...([envelope.event, envelope.payload] as BroadcastMessage),
        )
    }

    return {
        async start(): Promise<void> {
            if (subscriber !== null) return
            const client = deps.createSubscriber()
            client.on('error', (err: unknown) => {
                logger.warn({ err }, 'User event bus subscriber error')
            })
            client.on('message', onMessage)
            subscriber = client
            // ioredis subscribes again by itself after a reconnect (autoResubscribe).
            await client.subscribe(deps.channel)
            logger.info({ channel: deps.channel }, 'User event bus subscribed')
        },

        async stop(): Promise<void> {
            const client = subscriber
            subscriber = null
            if (client === null) return
            client.off('message', onMessage)
            // A subscriber has nothing to flush; QUIT would wait for a Redis that may be down.
            client.disconnect()
            await Promise.resolve()
        },

        async publishToUser(userId, ...message): Promise<void> {
            const [event, payload] = message
            if (subscriber === null || !BUS_EVENTS.has(event)) {
                // Not subscribed (a script, a test without the bus): this process only.
                deps.deliverLocally(userId, ...message)
                return
            }
            const envelope: BusEnvelope = { v: 1, userId, event, payload }
            try {
                await deps.publish(deps.channel, JSON.stringify(envelope))
            } catch (err) {
                logger.warn(
                    { err, userId, event },
                    'User event bus publish failed, delivering on this instance only',
                )
                deps.deliverLocally(userId, ...message)
            }
        },
    }
}

/**
 * The channel holds the key prefix: deployments (and test runs) sharing one Redis with different
 * prefixes do not see each other's events. Pub/sub channels ignore ioredis `keyPrefix`.
 */
export const USER_EVENTS_CHANNEL = `${redisConfig.keyPrefix}user-events`

export const userEventBus = createUserEventBus({
    channel: USER_EVENTS_CHANNEL,
    publish: (channel, message) => publisherClient.publish(channel, message),
    createSubscriber: () => {
        const { keyPrefix: _keyPrefix, ...options } = mainRedisOptions
        // A subscriber waits for its connection instead of failing fast: SUBSCRIBE is queued
        // until Redis answers, and sent again after every reconnect.
        return new Redis({ ...options, enableOfflineQueue: true, lazyConnect: false })
    },
    deliverLocally: (userId, ...message) =>
        broadcastService.broadcastMessageToUser(userId, ...message),
})
