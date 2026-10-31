import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'

const logger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}))
vi.mock('#logger', () => ({ default: logger }))

const redis = vi.hoisted(() => ({
    get: vi.fn(),
    expire: vi.fn(),
    del: vi.fn(),
    setex: vi.fn(),
}))
const withRedis = vi.hoisted(() => vi.fn(async <T>(op: () => Promise<T>): Promise<T> => op()))
vi.mock('#database/redis.js', () => ({ default: redis, withRedis }))

const checkSessionToken = vi.hoisted(() => vi.fn())
vi.mock('#app/services/auth/session-token-check.js', () => ({ checkSessionToken }))

const { wsSessionAuth } = await import('./ws-session-auth.js')
const { generateWsToken } = await import('#app/services/auth/generate-ws-token-service.js')

const TOKEN_DATA = JSON.stringify({ sessionId: 's1', userId: '1', userToken: 'u1' })
const SESSION_DATA = JSON.stringify({ id: 's1', data: { userId: '1' } })

beforeEach(() => {
    vi.clearAllMocks()
    withRedis.mockImplementation(async (op) => op())
    checkSessionToken.mockResolvedValue('ok')
})

describe('verifyUpgradeToken', () => {
    it('ok when token and session match', async () => {
        redis.get.mockResolvedValueOnce(TOKEN_DATA).mockResolvedValueOnce(SESSION_DATA)
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'ok',
            sessionId: 's1',
            userId: '1',
            userToken: 'u1',
        })
    })

    // ADR 0002: the Redis records are intact, but users.sessionToken was rotated.
    it('missing when the sessionToken was rotated, though the session record exists', async () => {
        redis.get.mockResolvedValueOnce(TOKEN_DATA).mockResolvedValueOnce(SESSION_DATA)
        checkSessionToken.mockResolvedValue('mismatch')
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'missing',
        })
        expect(checkSessionToken).toHaveBeenCalledWith('1', 'u1')
    })

    it('unavailable when the sessionToken lookup fails: no access on the Redis record alone', async () => {
        redis.get.mockResolvedValueOnce(TOKEN_DATA).mockResolvedValueOnce(SESSION_DATA)
        checkSessionToken.mockResolvedValue('unavailable')
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'unavailable',
        })
    })

    it('does not look the sessionToken up when the session record is missing', async () => {
        redis.get.mockResolvedValueOnce(TOKEN_DATA).mockResolvedValueOnce(null)
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'missing',
        })
        expect(checkSessionToken).not.toHaveBeenCalled()
    })

    it('missing when the token is unknown', async () => {
        redis.get.mockResolvedValueOnce(null)
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'missing',
        })
    })

    it('unavailable after the first failed command, without the session lookup', async () => {
        withRedis.mockRejectedValueOnce(new RedisUnavailableError())
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'unavailable',
        })
        expect(withRedis).toHaveBeenCalledTimes(1)
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('unavailable when the session lookup fails', async () => {
        redis.get.mockResolvedValueOnce(TOKEN_DATA)
        withRedis
            .mockImplementationOnce(async (op) => op())
            .mockRejectedValueOnce(new RedisUnavailableError())
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'unavailable',
        })
    })

    it('missing (logged) on other errors, as before', async () => {
        redis.get.mockResolvedValueOnce('{not json')
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'missing',
        })
        expect(logger.error).toHaveBeenCalledTimes(1)
    })
})

describe('refreshToken, revokeToken, generateWsToken', () => {
    it.each([
        ['refreshToken', () => wsSessionAuth.refreshToken('t')],
        ['revokeToken', () => wsSessionAuth.revokeToken('t')],
        [
            'generateWsToken',
            () => generateWsToken({ id: 's1', data: { userToken: 'u1' }, createdAt: '' }, '1'),
        ],
    ])('%s rejects with RedisUnavailableError when Redis is down', async (_, call) => {
        withRedis.mockRejectedValue(new RedisUnavailableError())
        await expect(call()).rejects.toBeInstanceOf(RedisUnavailableError)
        expect(withRedis).toHaveBeenCalledTimes(1)
    })
})
