import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-058: PUT /push-subscriptions/:id and PUT /:id/deactivate used to re-read the
// row by id alone after a user-scoped UPDATE, so a foreign id answered 200 with
// another user's subscription (endpoint, push keys, IP, user agent). The real
// controller, service and repository run against PostgreSQL; only the request
// context is built by hand.
describe.skipIf(!hasPg)('push subscription ownership on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { pushSubscriptions, users } = await import('#database/schema.js')
    const { default: controller } = await import('./push-subscription-controller.js')
    const { createResponseData } = await import('#vendor/utils/network/response-data.js')

    const now = Date.now()
    const ids = { owner: 0n, other: 0n, ownerSub: 0n, otherSub: 0n, missing: 0n }

    const insertUser = async (name: string): Promise<bigint> => {
        const [row] = await db
            .insert(users)
            .values({ name, email: `${name}-${String(now)}@example.test` })
            .returning({ id: users.id })
        if (row === undefined) throw new Error('user not inserted')
        return row.id
    }

    const insertSubscription = async (userId: bigint, tag: string): Promise<bigint> => {
        const [row] = await db
            .insert(pushSubscriptions)
            .values({
                userId,
                endpoint: `https://push.example.test/${tag}-${String(now)}`,
                p256dhKey: `p256dh-${tag}`,
                authKey: `auth-${tag}`,
                ipAddress: '203.0.113.7',
                userAgent: `agent-${tag}`,
                isActive: true,
            })
            .returning({ id: pushSubscriptions.id })
        if (row === undefined) throw new Error('subscription not inserted')
        return row.id
    }

    const contextFor = (actingUserId: bigint, subscriptionId: bigint, payload: object) => {
        const responseData = createResponseData()
        return {
            responseData,
            context: {
                auth: { check: () => true, getUserId: () => String(actingUserId) },
                httpData: { params: { subscriptionId: String(subscriptionId) }, payload },
                responseData,
                logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            } as never,
        }
    }

    const rowOf = async (id: bigint) => {
        const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id))
        return row
    }

    beforeAll(async () => {
        ids.owner = await insertUser('push-owner')
        ids.other = await insertUser('push-other')
        ids.ownerSub = await insertSubscription(ids.owner, 'owner')
        ids.otherSub = await insertSubscription(ids.other, 'other')
        ids.missing = ids.otherSub + 1_000_000n
    })

    afterAll(async () => {
        await db.delete(users).where(eq(users.id, ids.owner))
        await db.delete(users).where(eq(users.id, ids.other))
        await pool.end()
    })

    describe('PUT /push-subscriptions/:subscriptionId', () => {
        it('answers a foreign id like a missing one and leaks nothing', async () => {
            const before = await rowOf(ids.ownerSub)

            const foreign = contextFor(ids.other, ids.ownerSub, { isActive: false })
            const foreignBody = await controller.updateSubscription(foreign.context)
            const missing = contextFor(ids.other, ids.missing, { isActive: false })
            const missingBody = await controller.updateSubscription(missing.context)

            expect(foreign.responseData.status).toBe(404)
            expect(missing.responseData.status).toBe(404)
            expect(foreignBody).toEqual(missingBody)
            const serialized = JSON.stringify(foreignBody)
            expect(serialized).not.toContain('push.example.test')
            expect(serialized).not.toContain('p256dh-owner')
            expect(serialized).not.toContain('203.0.113.7')
            expect(await rowOf(ids.ownerSub)).toEqual(before)
        })

        it('leaks nothing for an empty payload either', async () => {
            const foreign = contextFor(ids.other, ids.ownerSub, {})

            const body = await controller.updateSubscription(foreign.context)

            expect(foreign.responseData.status).toBe(404)
            expect(JSON.stringify(body)).not.toContain('p256dh-owner')
        })

        it('updates the caller own subscription', async () => {
            const own = contextFor(ids.owner, ids.ownerSub, { isActive: false, timezone: 'UTC' })

            const body = await controller.updateSubscription(own.context)

            expect(own.responseData.status).toBe(200)
            expect(body).toMatchObject({ status: 'success' })
            const row = await rowOf(ids.ownerSub)
            expect(row?.isActive).toBe(false)
            expect(row?.timezone).toBe('UTC')
        })
    })

    describe('PUT /push-subscriptions/:subscriptionId/deactivate', () => {
        it('answers a foreign id like a missing one, leaks nothing and keeps the row active', async () => {
            const before = await rowOf(ids.otherSub)

            const foreign = contextFor(ids.owner, ids.otherSub, {})
            const foreignBody = await controller.deactivateSubscription(foreign.context)
            const missing = contextFor(ids.owner, ids.missing, {})
            const missingBody = await controller.deactivateSubscription(missing.context)

            expect(foreign.responseData.status).toBe(404)
            expect(missing.responseData.status).toBe(404)
            expect(foreignBody).toEqual(missingBody)
            const serialized = JSON.stringify(foreignBody)
            expect(serialized).not.toContain('push.example.test')
            expect(serialized).not.toContain('p256dh-other')
            expect(serialized).not.toContain('203.0.113.7')
            const after = await rowOf(ids.otherSub)
            expect(after).toEqual(before)
            expect(after?.isActive).toBe(true)
        })

        it('deactivates the caller own subscription', async () => {
            const own = contextFor(ids.other, ids.otherSub, {})

            const body = await controller.deactivateSubscription(own.context)

            expect(own.responseData.status).toBe(200)
            expect(body).toMatchObject({ status: 'success' })
            expect((await rowOf(ids.otherSub))?.isActive).toBe(false)
        })
    })

    // The endpoint is unique across users. Moving it to another account is allowed
    // only with the browser's keys (same device, account switch) — the repository
    // method has no userId in its WHERE on purpose.
    describe('createSubscription for an endpoint owned by another user', () => {
        const create = async (actingUserId: bigint, endpoint: string, keys: string) => {
            const { responseData, context } = contextFor(actingUserId, 0n, {
                endpoint,
                p256dhKey: keys,
                authKey: `auth-${keys}`,
            })
            const body = await controller.createSubscription(context)
            return { status: responseData.status, body }
        }

        it('moves the subscription to the caller when the browser keys match', async () => {
            const id = await insertSubscription(ids.owner, 'move')
            const row = await rowOf(id)
            if (row === undefined) throw new Error('subscription missing')
            const { responseData, context } = contextFor(ids.other, 0n, {
                endpoint: row.endpoint,
                p256dhKey: row.p256dhKey,
                authKey: row.authKey,
            })

            await controller.createSubscription(context)

            expect(responseData.status).toBe(200)
            expect((await rowOf(id))?.userId).toBe(ids.other)
        })

        it('answers 409 and keeps the owner when the keys differ', async () => {
            const id = await insertSubscription(ids.owner, 'conflict')
            const row = await rowOf(id)
            if (row === undefined) throw new Error('subscription missing')

            const { status } = await create(ids.other, row.endpoint, 'wrong-keys')

            expect(status).toBe(409)
            expect((await rowOf(id))?.userId).toBe(ids.owner)
        })
    })
})
