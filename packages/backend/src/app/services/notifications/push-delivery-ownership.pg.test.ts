import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-148 (review 2026-11-10, M9): where a notification of an account goes after the
// subscription of a shared browser was released or moved. Repositories and PostgreSQL are real;
// only the transport is replaced, so nothing reaches a push service.

const sendPush = vi.hoisted(() => vi.fn())
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn() } }))
vi.mock('./push-transport.js', () => ({ sendPush }))
vi.mock('#config/push.js', () => ({
    default: {
        vapidPublicKey: 'pub',
        vapidPrivateKey: 'priv',
        vapidSubject: 'mailto:x@y.z',
        allowedEndpointHosts: ['fcm.googleapis.com'],
        maxSubscriptionsPerUser: 20,
        configError: null,
    },
}))
vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('#app/websocket/ws-connection-registry.js', () => ({
    wsConnectionRegistry: { isUserOnline: vi.fn(() => false) },
}))

describe.skipIf(!hasPg)('push delivery after a browser changes accounts', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users } = await import('#database/schema.js')
    const { pushSubscriptionRepository } = await import('#app/repositories/index.js')
    const { pushNotificationSenderService } = await import('./push-notification-sender-service.js')

    const stamp = String(Date.now())
    const endpoint = `https://fcm.googleapis.com/fcm/send/shared-browser-${stamp}`
    const ids = { userA: 0n, userB: 0n, subscription: 0n }
    const payload = { title: 'New sign-in', body: 'B', data: { type: 'test' } }

    const insertUser = async (name: string): Promise<bigint> => {
        const [row] = await db
            .insert(users)
            .values({ name, email: `${name}-${stamp}@example.test` })
            .returning({ id: users.id })
        if (row === undefined) throw new Error('user not inserted')
        return row.id
    }

    const sentEndpoints = (): string[] =>
        sendPush.mock.calls.map(([subscription]) => (subscription as { endpoint: string }).endpoint)

    beforeAll(async () => {
        ids.userA = await insertUser('delivery-a')
        ids.userB = await insertUser('delivery-b')
        const created = await pushSubscriptionRepository.create({
            userId: ids.userA,
            endpoint,
            p256dhKey: 'p',
            authKey: 'a',
        })
        ids.subscription = created.id
    })

    beforeEach(() => {
        sendPush.mockReset()
        sendPush.mockResolvedValue({ statusCode: 201 })
    })

    afterAll(async () => {
        await db.delete(users).where(eq(users.id, ids.userA))
        await db.delete(users).where(eq(users.id, ids.userB))
        await pool.end()
    })

    it('reaches the browser while the subscription is the account’s', async () => {
        expect(await pushNotificationSenderService.sendToUser(ids.userA, payload)).toEqual({
            sent: 1,
            failed: 0,
        })
        expect(sentEndpoints()).toEqual([endpoint])
    })

    it('after the subscription moved to another account, the previous one sends nothing there', async () => {
        await pushSubscriptionRepository.updateByEndpoint(endpoint, ids.userB, {})

        expect(await pushNotificationSenderService.sendToUser(ids.userA, payload)).toEqual({
            sent: 0,
            failed: 0,
        })
        expect(sendPush).not.toHaveBeenCalled()

        expect(await pushNotificationSenderService.sendToUser(ids.userB, payload)).toEqual({
            sent: 1,
            failed: 0,
        })
        expect(sentEndpoints()).toEqual([endpoint])
    })

    it('after a sign-out removed the record, nobody sends to the browser', async () => {
        expect(await pushSubscriptionRepository.delete(ids.subscription, ids.userB)).toBe(true)

        await pushNotificationSenderService.sendToUser(ids.userA, payload)
        await pushNotificationSenderService.sendToUser(ids.userB, payload)

        expect(sendPush).not.toHaveBeenCalled()
    })
})
