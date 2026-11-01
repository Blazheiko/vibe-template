import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { badRequest, unauthorized } from '#app/services/shared/errors.js'
import type { ThrottlePolicy } from '#config/throttle-policies.js'

const consumeAuthThrottleMock = vi.fn()
vi.mock('./auth-throttle-service.js', () => ({ consumeAuthThrottle: consumeAuthThrottleMock }))

const policy = { scope: 'unit_test' } as ThrottlePolicy
const answers = {
    unavailable: 'Failed to enforce unit throttle',
    rejected: badRequest('Too many tries'),
}

afterEach(() => {
    vi.resetAllMocks()
})

describe('enforceThrottle', () => {
    it('is ok while the counter allows the attempt, and consumes exactly this policy and key', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        const { enforceThrottle } = await import('./enforce-throttle.js')
        const result = await enforceThrottle(policy, 'k', answers)
        expect(Result.isOk(result)).toBe(true)
        expect(consumeAuthThrottleMock).toHaveBeenCalledExactlyOnceWith(policy, 'k')
    })

    it('answers with the given error once the counter is spent', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 99 })
        const { enforceThrottle } = await import('./enforce-throttle.js')
        const result = await enforceThrottle(policy, 'k', {
            ...answers,
            rejected: unauthorized('Invalid email or password'),
        })
        expect(Result.isError(result) && result.error).toEqual(
            unauthorized('Invalid email or password'),
        )
    })

    it('fails closed with an internal error and its own message when Redis fails', async () => {
        const cause = new Error('redis down')
        consumeAuthThrottleMock.mockRejectedValue(cause)
        const { enforceThrottle } = await import('./enforce-throttle.js')
        const result = await enforceThrottle(policy, 'k', answers)
        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'Internal',
            publicMessage: 'Failed to enforce unit throttle',
            cause,
        })
    })

    it('answers 503 and not 500 when Redis is unreachable', async () => {
        consumeAuthThrottleMock.mockRejectedValue(new Error('Command timed out'))
        const { enforceThrottle } = await import('./enforce-throttle.js')
        const result = await enforceThrottle(policy, 'k', answers)
        expect(Result.isError(result) && result.error._tag).toBe('ServiceUnavailable')
    })
})
