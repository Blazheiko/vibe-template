import { ms } from 'shared/brand'
import { describe, expect, it, vi } from 'vitest'

import { consumeRedisSlidingLog, slidingLogKey } from './redis-sliding-log.js'

describe('consumeRedisSlidingLog', () => {
    it('passes key, window, max and a nonce to one Lua call', async () => {
        const evalMock = vi.fn().mockResolvedValue([1, 59, 1_060_000])
        const decision = await consumeRedisSlidingLog(
            { eval: evalMock },
            slidingLogKey('upgrade', '10.0.0.1'),
            { windowMs: ms(60_000), max: 60 },
            'nonce-1',
        )
        expect(evalMock).toHaveBeenCalledTimes(1)
        expect(evalMock).toHaveBeenCalledWith(
            expect.stringContaining('ZREMRANGEBYSCORE'),
            1,
            'rl:upgrade:10.0.0.1',
            '60000',
            '60',
            'nonce-1',
        )
        expect(decision).toEqual({
            allowed: true,
            limit: 60,
            remaining: 59,
            resetAt: 1_060_000,
        })
    })

    it('maps a rejection to retryAfterMs', async () => {
        const evalMock = vi.fn().mockResolvedValue([0, 1500, 1_001_500])
        await expect(
            consumeRedisSlidingLog({ eval: evalMock }, 'k', {
                windowMs: ms(60_000),
                max: 1,
            }),
        ).resolves.toEqual({
            allowed: false,
            limit: 1,
            retryAfterMs: 1500,
            resetAt: 1_001_500,
        })
    })

    it('uses a fresh nonce per call by default', async () => {
        const evalMock = vi.fn().mockResolvedValue([1, 0, 0])
        await consumeRedisSlidingLog({ eval: evalMock }, 'k', {
            windowMs: ms(1),
            max: 2,
        })
        await consumeRedisSlidingLog({ eval: evalMock }, 'k', {
            windowMs: ms(1),
            max: 2,
        })
        const nonces = evalMock.mock.calls.map((call) => call[5] as string)
        expect(nonces[0]).not.toBe(nonces[1])
    })
})
