import { describe, expect, it, vi } from 'vitest'
import { ms } from 'shared/brand'

import type { ThrottlePolicy } from '#config/throttle-policies.js'

const evalMock = vi.fn()
const delMock = vi.fn()

vi.mock('#database/redis-rate-limit.js', () => ({
    default: {
        eval: evalMock,
        del: delMock,
    },
}))

const policy: ThrottlePolicy = {
    scope: 'confirm_phone_ip',
    keyBy: 'ip',
    algorithm: 'fixed-window',
    limit: 20,
    windowMs: ms(3_600_000),
    onRedisError: 'reject',
}

describe('consumeAuthThrottle', () => {
    it('increments the auth throttle key atomically with PEXPIRE applied on first hit', async () => {
        evalMock.mockResolvedValue(1)

        const { consumeAuthThrottle } = await import('./auth-throttle-service.js')
        const result = await consumeAuthThrottle(policy, '127.0.0.1')

        expect(result).toEqual({ allowed: true, count: 1 })
        expect(evalMock).toHaveBeenCalledWith(
            expect.stringContaining("redis.call('PEXPIRE'"),
            1,
            'auth:throttle:confirm_phone_ip:127.0.0.1',
            '3600000',
        )
    })

    it('rejects once the count exceeds the policy limit', async () => {
        evalMock.mockResolvedValue(21)
        const { consumeAuthThrottle } = await import('./auth-throttle-service.js')
        await expect(consumeAuthThrottle(policy, 'ip')).resolves.toEqual({
            allowed: false,
            count: 21,
        })
    })

    it('propagates a Redis error once, without retrying', async () => {
        evalMock.mockReset()
        evalMock.mockRejectedValueOnce(new Error('Command timed out'))
        const { consumeAuthThrottle } = await import('./auth-throttle-service.js')
        await expect(consumeAuthThrottle(policy, 'ip')).rejects.toThrow('Command timed out')
        expect(evalMock).toHaveBeenCalledTimes(1)
    })
})

describe('resetAuthThrottle', () => {
    it('deletes the same key consumeAuthThrottle writes', async () => {
        const { resetAuthThrottle } = await import('./auth-throttle-service.js')
        await resetAuthThrottle(policy, '127.0.0.1')
        expect(delMock).toHaveBeenCalledWith('auth:throttle:confirm_phone_ip:127.0.0.1')
    })
})
