import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import type { Profile } from 'shared'
import type { SessionAuthState } from 'shared/mfa'
import { afterAll, describe, expect, it, vi } from 'vitest'

import type { ListedConnection } from '#app/websocket/ws-connection-registry.js'
import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'
import { hasRedis, REDIS_TEST_URL } from '../../../test-support/redis-test-client.js'

vi.mock('#database/redis.js', () => ({ default: { publish: vi.fn() } }))
const broadcastMessageToUserConnection = vi.fn()
vi.mock('#app/services/communication/broadcast-service.js', () => ({
    broadcastService: { broadcastMessageToUser: vi.fn(), broadcastMessageToUserConnection },
}))
// feat-247: the staff rule on, so a step-up changes what a connection may do.
vi.mock('#config/mfa.js', () => ({
    default: { requiredForStaff: true, staffFactor: 'any', staffFactorMaxAgeHours: 12 },
}))

const { createUserEventBus } = await import('./user-event-bus.js')
const { createWsSessionAuthSync } = await import('#app/websocket/ws-session-auth-sync.js')

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
    const handled: unknown[][] = []
    bus.handleServerEvents((event, userId, payload) => {
        handled.push(payload === undefined ? [event, userId] : [event, userId, payload])
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

    // feat-247 (Р11): a server event carries a payload across instances.
    it('session_auth_changed of A reaches B with its payload, not A again', async () => {
        const channel = `test:${randomUUID()}:user-events`
        const a = instance(channel)
        const b = instance(channel)
        await a.bus.start()
        await b.bus.start()

        await a.bus.notifyOtherInstances('7', 'session_auth_changed', { sessionId: 'sess-1' })

        await vi.waitFor(() => {
            expect(b.handled).toEqual([['session_auth_changed', '7', { sessionId: 'sess-1' }]])
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(a.handled).toEqual([])
        expect(b.delivered).toEqual([])
        await a.bus.stop()
        await b.bus.stop()
    })

    it('an old-form server event (no payload) still works; an invalid payload is ignored', async () => {
        const channel = `test:${randomUUID()}:user-events`
        const b = instance(channel)
        await b.bus.start()
        const raw = client()
        const envelope = (event: string, payload?: unknown): string =>
            JSON.stringify({
                v: 1,
                origin: 'old-instance',
                userId: '9',
                event,
                ...(payload === undefined ? {} : { payload }),
            })

        await raw.publish(channel, envelope('session_auth_changed', { sessionId: 7 }))
        await raw.publish(channel, envelope('session_auth_changed'))
        await raw.publish(channel, envelope('user_role_changed'))

        await vi.waitFor(() => {
            expect(b.handled).toEqual([['user_role_changed', '9']])
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(b.handled).toEqual([['user_role_changed', '9']])
        await b.bus.stop()
    })

    it('a step-up on instance A updates the auth of the session connection held by B', async () => {
        const channel = `test:${randomUUID()}:user-events`
        const store = client()
        const sessionId = `s-${randomUUID()}`
        const userToken = `t-${randomUUID()}`
        const key = `test:${randomUUID()}:session:${userToken}:${sessionId}`
        const now = Date.now()
        const raised: SessionAuthState = {
            v: 1,
            amr: ['pwd', 'otp'],
            aal: 2,
            authenticatedAt: new Date(now - 13 * 3_600_000).toISOString(),
            verified: { otp: new Date(now).toISOString() },
        }

        // B holds a connection of the session whose proof went stale (the deadline took it out).
        const userData = {
            uuid: 'conn-b',
            userId: '7',
            sessionId,
            userToken,
            role: 'admin',
            mfaStale: true,
            auth: { ...raised, verified: { otp: new Date(now - 13 * 3_600_000).toISOString() } },
        } as unknown as UserConnection
        const ws = { getUserData: () => userData } as unknown as MyWebSocket
        const connections: ListedConnection[] = [
            { userId: '7', uuid: 'conn-b', ws, sessionId, userToken },
        ]
        const syncB = createWsSessionAuthSync({
            listUserConnections: (userId) => (userId === '7' ? connections : []),
            readSession: async (id, token) => {
                expect([id, token]).toEqual([sessionId, userToken])
                const json = await store.get(key)
                return json === null
                    ? null
                    : (JSON.parse(json) as { data: { auth: SessionAuthState } })
            },
        })

        const a = instance(channel)
        const b = instance(channel)
        const refreshed: Promise<number>[] = []
        b.bus.handleServerEvents((event, userId, payload) => {
            if (event === 'session_auth_changed' && payload !== undefined) {
                refreshed.push(syncB.refresh(userId, payload.sessionId))
            }
        })
        await a.bus.start()
        await b.bus.start()

        // The step-up on A: the session record gets the new mark, then A tells the others.
        await store.set(
            key,
            JSON.stringify({ id: sessionId, data: { userId: '7', auth: raised } }),
            'EX',
            60,
        )
        await a.bus.notifyOtherInstances('7', 'session_auth_changed', { sessionId })

        await vi.waitFor(() => {
            expect(refreshed).toHaveLength(1)
        })
        expect(await refreshed[0]).toBe(1)
        expect(userData.auth).toEqual(raised)
        expect(userData.mfaStale).toBe(false)
        expect(broadcastMessageToUserConnection).toHaveBeenCalledWith(
            '7',
            'conn-b',
            'admin_channel_ready',
            {},
        )
        await store.del(key)
        await a.bus.stop()
        await b.bus.stop()
    })
})
