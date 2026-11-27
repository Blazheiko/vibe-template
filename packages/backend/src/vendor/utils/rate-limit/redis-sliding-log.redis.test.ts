import { ms } from 'shared/brand'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../../test-support/redis-test-client.js'
import { createRateLimitStore, type RateLimitDecision } from './rate-limit-store.js'
import { consumeRedisSlidingLog } from './redis-sliding-log.js'

const redis = createTestRedis()

beforeAll(async () => {
    if (hasRedis) await redis.connect()
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(redis)
    await redis.quit()
})

// One table of cases for both implementations: the Lua script must make the
// same decisions as the in-memory store.
const CASES = [
    {
        name: 'max 3: three pass, then rejects',
        max: 3,
        windowMs: ms(60_000),
        attempts: 5,
    },
    { name: 'max 1: one passes', max: 1, windowMs: ms(60_000), attempts: 3 },
    { name: 'max 5: all pass', max: 5, windowMs: ms(60_000), attempts: 5 },
]

const summarize = (decisions: RateLimitDecision[]) =>
    decisions.map((d) => (d.allowed ? `ok:${String(d.remaining)}` : 'rejected'))

describe.skipIf(!hasRedis)('Redis sliding log', () => {
    it.each(CASES)('matches the in-memory store: $name', async ({ max, windowMs, attempts }) => {
        const memory = createRateLimitStore()
        const memoryDecisions: RateLimitDecision[] = []
        const redisDecisions: RateLimitDecision[] = []
        const key = `sl:${String(max)}:${String(attempts)}`
        for (let i = 0; i < attempts; i++) {
            memoryDecisions.push(memory.consume(key, { windowMs: ms(windowMs), max }))
            redisDecisions.push(
                await consumeRedisSlidingLog(redis, key, { windowMs: ms(windowMs), max }),
            )
        }
        expect(summarize(redisDecisions)).toEqual(summarize(memoryDecisions))
        for (const decision of redisDecisions) {
            if (!decision.allowed) {
                expect(decision.retryAfterMs).toBeGreaterThan(windowMs - 1_000)
                expect(decision.retryAfterMs).toBeLessThanOrEqual(windowMs)
            }
        }
    })

    it('does not store rejected attempts and keeps the TTL within the window', async () => {
        const key = 'sl:rejected'
        for (let i = 0; i < 6; i++) {
            await consumeRedisSlidingLog(redis, key, { windowMs: ms(60_000), max: 2 })
        }
        expect(await redis.zcard(key)).toBe(2)
        const ttl = await redis.pttl(key)
        expect(ttl).toBeGreaterThan(60_000 - 1_000)
        expect(ttl).toBeLessThanOrEqual(60_000)
    })

    it('frees a slot exactly when retryAfterMs says', async () => {
        const key = 'sl:retry'
        await consumeRedisSlidingLog(redis, key, { windowMs: ms(300), max: 1 })
        const rejected = await consumeRedisSlidingLog(redis, key, {
            windowMs: ms(300),
            max: 1,
        })
        expect(rejected.allowed).toBe(false)
        if (rejected.allowed) return
        expect(rejected.retryAfterMs).toBeLessThanOrEqual(300)
        await sleep(rejected.retryAfterMs + 30)
        const again = await consumeRedisSlidingLog(redis, key, {
            windowMs: ms(300),
            max: 1,
        })
        expect(again.allowed).toBe(true)
    })

    it('concurrent calls never exceed max and lose no attempts', async () => {
        const key = 'sl:burst'
        const decisions = await Promise.all(
            Array.from({ length: 50 }, () =>
                consumeRedisSlidingLog(redis, key, { windowMs: ms(60_000), max: 10 }),
            ),
        )
        expect(decisions.filter((d) => d.allowed)).toHaveLength(10)
        expect(await redis.zcard(key)).toBe(10)
    })

    it('two clients (instances) share one budget', async () => {
        const other = createTestRedis(redis.options.keyPrefix)
        await other.connect()
        try {
            const key = 'sl:shared'
            const options = { windowMs: ms(60_000), max: 2 }
            expect((await consumeRedisSlidingLog(redis, key, options)).allowed).toBe(true)
            expect((await consumeRedisSlidingLog(other, key, options)).allowed).toBe(true)
            expect((await consumeRedisSlidingLog(redis, key, options)).allowed).toBe(false)
            expect((await consumeRedisSlidingLog(other, key, options)).allowed).toBe(false)
        } finally {
            await other.quit()
        }
    })
})
