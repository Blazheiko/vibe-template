import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import logger from '#vendor/utils/logger.js'
import redisConfig from '#config/redis.js'
import publisherClient from '#database/redis.js'
import { mainRedisOptions } from '#database/redis-main-options.js'
import { broadcastService } from '#app/services/communication/broadcast-service.js'
import type { BroadcastEventName, BroadcastMessage } from 'shared/schemas'

/**
 * Events for every connection of a user, whichever backend instance holds it (feat-232, Р9 B).
 * `broadcastService.broadcastMessageToUser` reaches only the connections of this process. The
 * instance that has an event delivers it to its own connections at once, whatever Redis does,
 * and publishes it on one channel for the other instances; each of them is subscribed and
 * delivers it to its connections. Its own echo from Redis carries its instance id and is
 * skipped, so a connection of the publishing instance gets the event exactly once, also while
 * its SUBSCRIBE is still pending or Redis is down.
 *
 * Delivery to the other instances is best effort, as any broadcast: an event published while an
 * instance is not subscribed is not replayed. The client re-reads the profile on every connect.
 */

/** The events allowed on the bus; others go through `broadcastService` of their instance. */
const BUS_EVENTS: ReadonlySet<BroadcastEventName> = new Set([
    'user_profile_updated',
    'user_sessions_changed',
    'notifications_changed',
    'notification_preferences_changed',
])

/**
 * feat-240 (Р8): events for the instances themselves, never delivered to a client. A role change
 * makes every instance re-read the role of the user's open connections.
 */
export const SERVER_BUS_EVENTS = ['user_role_changed', 'session_auth_changed'] as const
export type ServerBusEvent = (typeof SERVER_BUS_EVENTS)[number]
const SERVER_EVENTS: ReadonlySet<string> = new Set(SERVER_BUS_EVENTS)

/**
 * feat-247 (Р11): the data a server event carries. `user_role_changed` carries none (its old
 * form); `session_auth_changed` names the session whose auth state rose (a step-up).
 */
export interface ServerBusPayloads {
    user_role_changed: undefined
    session_auth_changed: { sessionId: string }
}
export type ServerEventPayload = ServerBusPayloads[ServerBusEvent]

/** The payload argument of a server event: none for an event without data. */
export type ServerEventArgs<E extends ServerBusEvent> = ServerBusPayloads[E] extends undefined
    ? []
    : [payload: ServerBusPayloads[E]]

/** What an instance does with a server event of a user. */
export type ServerEventHandler = (
    event: ServerBusEvent,
    userId: string,
    payload?: ServerEventPayload,
) => void

const SESSION_ID_MAX = 256

/**
 * The payload of a received server event, checked against its event; `invalid` when it does not
 * match (the event is ignored). An event without data ignores what its envelope holds.
 */
export const parseServerPayload = (
    event: ServerBusEvent,
    payload: unknown,
): { ok: true; payload: ServerEventPayload } | { ok: false } => {
    if (event === 'user_role_changed') return { ok: true, payload: undefined }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { ok: false }
    }
    const record = payload as Record<string, unknown>
    const keys = Object.keys(record)
    const { sessionId } = record
    if (
        keys.length !== 1 ||
        typeof sessionId !== 'string' ||
        sessionId === '' ||
        sessionId.length > SESSION_ID_MAX
    ) {
        return { ok: false }
    }
    return { ok: true, payload: { sessionId } }
}

interface BusEnvelope {
    v: 1
    /** The instance that published it: its own echo is skipped there. */
    origin: string
    userId: string
    event: BroadcastEventName | ServerBusEvent
    payload: unknown
}

const isServerEvent = (event: string): event is ServerBusEvent => SERVER_EVENTS.has(event)

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
    const { origin, userId, event } = record
    if (typeof origin !== 'string' || origin === '') return null
    if (typeof userId !== 'string' || !USER_ID.test(userId)) return null
    if (typeof event !== 'string') return null
    if (!BUS_EVENTS.has(event as BroadcastEventName) && !isServerEvent(event)) return null
    return {
        v: 1,
        origin,
        userId,
        event: event as BroadcastEventName | ServerBusEvent,
        payload: record['payload'],
    }
}

export interface UserEventBusDeps {
    channel: string
    /** This process; defaults to a random id. */
    instanceId?: string
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
    /** The handler of server events on this instance (set at start; none: they are ignored). */
    handleServerEvents(handler: ServerEventHandler | null): void
    /**
     * A server event: handled here at once, then published to the other instances when the bus
     * is started. Never throws; a failed publish is logged (their periodic pass catches up).
     */
    notifyServer<E extends ServerBusEvent>(
        userId: string,
        event: E,
        ...payload: ServerEventArgs<E>
    ): Promise<void>
    /**
     * feat-247 (Р11): a server event for the other instances only, when the bus is started; this
     * one has applied it itself. Never throws; a failed publish is logged.
     */
    notifyOtherInstances<E extends ServerBusEvent>(
        userId: string,
        event: E,
        ...payload: ServerEventArgs<E>
    ): Promise<void>
    /**
     * Only publishes a server event, without a subscriber or a local handler: for a process that
     * is not an instance (the user:set-role CLI). Rejects when Redis refuses.
     */
    publishRemote<E extends ServerBusEvent>(
        userId: string,
        event: E,
        ...payload: ServerEventArgs<E>
    ): Promise<void>
}

export function createUserEventBus(deps: UserEventBusDeps): UserEventBus {
    let subscriber: Redis | null = null
    let serverHandler: ServerEventHandler | null = null
    const instanceId = deps.instanceId ?? randomUUID()

    const runServerHandler = (
        event: ServerBusEvent,
        userId: string,
        payload: ServerEventPayload,
    ): void => {
        try {
            if (payload === undefined) serverHandler?.(event, userId)
            else serverHandler?.(event, userId, payload)
        } catch (err) {
            logger.error({ err, userId, event }, 'User event bus: server event handler failed')
        }
    }

    // An event without data keeps its old envelope (`payload: {}`).
    const envelopeOf = (
        userId: string,
        event: ServerBusEvent,
        payload: ServerEventPayload,
    ): string =>
        JSON.stringify({
            v: 1,
            origin: instanceId,
            userId,
            event,
            payload: payload ?? {},
        } satisfies BusEnvelope)

    const publishServer = async (
        userId: string,
        event: ServerBusEvent,
        payload: ServerEventPayload,
    ): Promise<void> => {
        if (subscriber === null) return
        try {
            await deps.publish(deps.channel, envelopeOf(userId, event, payload))
        } catch (err) {
            logger.warn(
                { err, userId, event },
                'User event bus publish failed: the other instances miss this event',
            )
        }
    }

    const onMessage = (channel: string, raw: string): void => {
        if (channel !== deps.channel) return
        const envelope = parseEnvelope(raw)
        if (envelope === null) {
            logger.warn({ channel }, 'User event bus: message dropped, not a known event')
            return
        }
        // Delivered here when it was published.
        if (envelope.origin === instanceId) return
        if (isServerEvent(envelope.event)) {
            const parsed = parseServerPayload(envelope.event, envelope.payload)
            if (!parsed.ok) {
                logger.warn(
                    { channel, event: envelope.event, userId: envelope.userId },
                    'User event bus: server event dropped, its payload does not match',
                )
                return
            }
            runServerHandler(envelope.event, envelope.userId, parsed.payload)
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

        handleServerEvents(handler): void {
            serverHandler = handler
        },

        async notifyServer(userId, event, ...payload): Promise<void> {
            const data: ServerEventPayload = payload[0]
            runServerHandler(event, userId, data)
            await publishServer(userId, event, data)
        },

        async notifyOtherInstances(userId, event, ...payload): Promise<void> {
            await publishServer(userId, event, payload[0])
        },

        async publishRemote(userId, event, ...payload): Promise<void> {
            await deps.publish(deps.channel, envelopeOf(userId, event, payload[0]))
        },

        async publishToUser(userId, ...message): Promise<void> {
            const [event, payload] = message
            // This process first, whatever Redis does: a pending SUBSCRIBE or a down Redis
            // must not lose the event for the connections held here.
            deps.deliverLocally(userId, ...message)
            if (subscriber === null || !BUS_EVENTS.has(event)) return
            const envelope: BusEnvelope = { v: 1, origin: instanceId, userId, event, payload }
            try {
                await deps.publish(deps.channel, JSON.stringify(envelope))
            } catch (err) {
                logger.warn(
                    { err, userId, event },
                    'User event bus publish failed: the other instances miss this event',
                )
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
