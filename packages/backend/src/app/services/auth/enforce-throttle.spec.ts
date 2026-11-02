import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { badRequest, unauthorized } from '#app/services/shared/errors.js'
import { classifyError } from '#vendor/utils/network/errors/classify-error.js'
import type { ThrottlePolicy } from '#config/throttle-policies.js'

const consumeAuthThrottleMock = vi.fn()
vi.mock('./auth-throttle-service.js', () => ({ consumeAuthThrottle: consumeAuthThrottleMock }))

const policy = { scope: 'unit_test' } as ThrottlePolicy
const rejected = badRequest('Too many tries')

afterEach(() => {
    vi.resetAllMocks()
})

describe('enforceThrottle', () => {
    it('is ok while the counter allows the attempt, and consumes exactly this policy and key', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        const { enforceThrottle } = await import('./enforce-throttle.js')
        const result = await enforceThrottle(policy, 'k', rejected)
        expect(Result.isOk(result)).toBe(true)
        expect(consumeAuthThrottleMock).toHaveBeenCalledExactlyOnceWith(policy, 'k')
    })

    it('answers with the given error once the counter is spent', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 99 })
        const { enforceThrottle } = await import('./enforce-throttle.js')
        const result = await enforceThrottle(policy, 'k', unauthorized('Invalid email or password'))
        expect(Result.isError(result) && result.error).toEqual(
            unauthorized('Invalid email or password'),
        )
    })

    // ADR 0004: a Redis failure is not an AppError. It rejects (fail closed: the caller
    // does nothing on its behalf) and the transport answers.
    it('fails closed by rejecting with the Redis error', async () => {
        const cause = new Error('redis down')
        consumeAuthThrottleMock.mockRejectedValue(cause)
        const { enforceThrottle } = await import('./enforce-throttle.js')
        await expect(enforceThrottle(policy, 'k', rejected)).rejects.toBe(cause)
    })

    it('a Redis outage becomes 503 at the transport, not 500', async () => {
        const cause = new Error('Command timed out')
        consumeAuthThrottleMock.mockRejectedValue(cause)
        const { enforceThrottle } = await import('./enforce-throttle.js')
        await expect(enforceThrottle(policy, 'k', rejected)).rejects.toBe(cause)
        expect(classifyError(cause)).toMatchObject({ status: 503, code: 'service_unavailable' })
    })
})
