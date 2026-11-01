import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../../test-support/redis-test-client.js'

// ADR 0003 on a real Redis: the reservation is one atomic check-and-add, and the settlement
// brings the counter to what was really spent.

const { redis } = vi.hoisted((): { redis: { client: unknown } } => ({
    redis: { client: null },
}))
vi.mock('#database/redis-rate-limit.js', () => ({
    get default() {
        return redis.client
    },
}))

const client = createTestRedis()
redis.client = client

const { reserveDailyTokens } = await import('./llm-budget-service.js')

const DAY = new Date('2026-03-05T10:00:00.000Z')
const keyOf = (user: bigint, day = '2026-03-05'): string => `llm:budget:${String(user)}:${day}`
const used = async (user: bigint, day?: string): Promise<number> =>
    Number((await client.get(keyOf(user, day))) ?? 0)

let nextUser = 100n
const freshUser = (): bigint => {
    nextUser += 1n
    return nextUser
}
const PARTS = { translation: 300, embedding: 100, chat: 1_000 } // 1400 in all

const reserve = async (user: bigint, limit: number, parts = PARTS, now = DAY) => {
    const result = await reserveDailyTokens(user, parts, { limit, now })
    if (!result.allowed) throw new Error('expected the reservation to be allowed')
    return result.reservation
}

beforeAll(async () => {
    if (hasRedis) await client.connect()
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(client)
    await client.quit()
})

describe.skipIf(!hasRedis)('reserveDailyTokens', () => {
    it('adds the whole estimate to the day counter and gives the key a TTL', async () => {
        const user = freshUser()

        const reservation = await reserve(user, 10_000)

        expect(reservation.reserved).toBe(1_400)
        expect(await used(user)).toBe(1_400)
        const ttl = await client.pttl(keyOf(user))
        expect(ttl).toBeGreaterThan(47 * 3_600_000)
        expect(ttl).toBeLessThanOrEqual(48 * 3_600_000)
    })

    it('refuses what does not fit and leaves the counter as it was', async () => {
        const user = freshUser()
        await reserve(user, 2_000)

        const second = await reserveDailyTokens(user, PARTS, { limit: 2_000, now: DAY })

        expect(second.allowed).toBe(false)
        expect(await used(user)).toBe(1_400)
    })

    it('says when to come back: the seconds left until the UTC midnight', async () => {
        const user = freshUser()
        await reserve(user, 1_500)

        const refused = await reserveDailyTokens(user, PARTS, {
            limit: 1_500,
            now: new Date('2026-03-05T23:00:00.000Z'),
        })

        expect(refused).toEqual({ allowed: false, retryAfterSeconds: 3_600 })
    })

    it('counts per user and per day', async () => {
        const [a, b] = [freshUser(), freshUser()]
        await reserve(a, 1_500)

        expect((await reserveDailyTokens(b, PARTS, { limit: 1_500, now: DAY })).allowed).toBe(true)
        const nextDay = new Date('2026-03-06T00:00:01.000Z')
        expect((await reserveDailyTokens(a, PARTS, { limit: 1_500, now: nextDay })).allowed).toBe(
            true,
        )
    })

    // The check and the addition must be one step, or N parallel requests all see the same
    // remainder.
    it('lets exactly as many of 20 parallel reservations through as fit', async () => {
        const user = freshUser()
        const one = { chat: 100 }

        const results = await Promise.all(
            Array.from({ length: 20 }, () =>
                reserveDailyTokens(user, one, { limit: 1_000, now: DAY }),
            ),
        )

        expect(results.filter((r) => r.allowed)).toHaveLength(10)
        expect(await used(user)).toBe(1_000)
    })

    it('never asks for more than the limit, so a small limit is not a dead end', async () => {
        const user = freshUser()

        const reservation = await reserve(user, 500)

        expect(reservation.reserved).toBe(500)
        expect(await used(user)).toBe(500)
    })

    it('does nothing in Redis when the budget is switched off (limit 0)', async () => {
        const user = freshUser()

        const reservation = await reserve(user, 0)
        reservation.begin('chat')
        reservation.record('chat', 5_000)
        await reservation.settle()

        expect(await client.exists(keyOf(user))).toBe(0)
    })
})

describe.skipIf(!hasRedis)('settling a reservation', () => {
    it('gives everything back when no call was started', async () => {
        const user = freshUser()
        const reservation = await reserve(user, 10_000)

        await reservation.settle()

        expect(await used(user)).toBe(0)
    })

    it('charges what a started call really used, below or above the estimate', async () => {
        const below = freshUser()
        const r1 = await reserve(below, 10_000)
        r1.begin('chat')
        r1.record('chat', 400)
        await r1.settle()
        expect(await used(below)).toBe(400)

        const above = freshUser()
        const r2 = await reserve(above, 10_000)
        r2.begin('chat')
        r2.record('chat', 2_500)
        await r2.settle()
        expect(await used(above)).toBe(2_500)
    })

    // Aborted mid-stream, timed out, provider error: the provider may have counted tokens,
    // and "cancel after the generation started" must not be free.
    it('keeps the estimate of a started call whose usage is unknown', async () => {
        const user = freshUser()
        const reservation = await reserve(user, 10_000)
        reservation.begin('chat')
        reservation.record('chat', null)

        await reservation.settle()

        expect(await used(user)).toBe(1_000)
    })

    it('keeps the estimate of a started call that never reported at all', async () => {
        const user = freshUser()
        const reservation = await reserve(user, 10_000)
        reservation.begin('chat')

        await reservation.settle()

        expect(await used(user)).toBe(1_000)
    })

    it('adds up a pipeline: used, not started, started without usage', async () => {
        const user = freshUser()
        const reservation = await reserve(user, 10_000)
        reservation.begin('translation')
        reservation.record('translation', 120)
        // embedding never started (the run stopped), chat started but was cut off
        reservation.begin('chat')

        await reservation.settle()

        expect(await used(user)).toBe(120 + 1_000)
    })

    it('settles once: the second call changes nothing', async () => {
        const user = freshUser()
        const reservation = await reserve(user, 10_000)
        await reservation.settle()
        await reservation.settle()

        expect(await used(user)).toBe(0)
    })

    it('settles the day it reserved, even when the settlement comes the next day', async () => {
        const user = freshUser()
        const reservation = await reserve(user, 10_000, PARTS, new Date('2026-03-05T23:59:59.000Z'))
        reservation.begin('chat')
        reservation.record('chat', 700)

        await reservation.settle()

        expect(await used(user, '2026-03-05')).toBe(700)
        expect(await client.exists(keyOf(user, '2026-03-06'))).toBe(0)
    })

    it('never drives the counter below zero (the key may have expired meanwhile)', async () => {
        const user = freshUser()
        const reservation = await reserve(user, 10_000)
        await client.del(keyOf(user))

        await reservation.settle()

        expect(await used(user)).toBe(0)
    })

    it('does not give the counter a new life: the TTL set on reserve stays', async () => {
        const user = freshUser()
        const reservation = await reserve(user, 10_000)
        reservation.begin('chat')
        reservation.record('chat', 100)

        await reservation.settle()

        expect(await client.pttl(keyOf(user))).toBeGreaterThan(0)
    })
})
