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
    getdel: vi.fn(),
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
const DAY_MS = 24 * 60 * 60_000
const SESSION_DATA = JSON.stringify({
    id: 's1',
    data: { userId: '1' },
    createdAt: new Date().toISOString(),
})

beforeEach(() => {
    vi.clearAllMocks()
    withRedis.mockImplementation(async (op) => op())
    checkSessionToken.mockResolvedValue('ok')
})

describe('verifyUpgradeToken', () => {
    it('ok when token and session match', async () => {
        redis.getdel.mockResolvedValueOnce(TOKEN_DATA)
        redis.get.mockResolvedValueOnce(SESSION_DATA)
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'ok',
            sessionId: 's1',
            userId: '1',
            userToken: 'u1',
        })
    })

    // feat-119 (F1): the same absolute lifetime as an HTTP request (SESSION_MAX_AGE_DAYS = 30).
    it('missing for a session past its maximum age, and its record is deleted', async () => {
        const old = JSON.stringify({
            id: 's1',
            data: { userId: '1' },
            createdAt: new Date(Date.now() - 31 * DAY_MS).toISOString(),
        })
        redis.getdel.mockResolvedValueOnce(TOKEN_DATA)
        redis.get.mockResolvedValueOnce(old)

        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({ kind: 'missing' })

        expect(checkSessionToken).not.toHaveBeenCalled()
        expect(redis.del).toHaveBeenCalledWith('session:u1:s1')
    })

    // ADR 0002: the Redis records are intact, but users.sessionToken was rotated.
    it('missing when the sessionToken was rotated, though the session record exists', async () => {
        redis.getdel.mockResolvedValueOnce(TOKEN_DATA)
        redis.get.mockResolvedValueOnce(SESSION_DATA)
        checkSessionToken.mockResolvedValue('mismatch')
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'missing',
        })
        expect(checkSessionToken).toHaveBeenCalledWith('1', 'u1')
    })

    it('unavailable when the sessionToken lookup fails: no access on the Redis record alone', async () => {
        redis.getdel.mockResolvedValueOnce(TOKEN_DATA)
        redis.get.mockResolvedValueOnce(SESSION_DATA)
        checkSessionToken.mockResolvedValue('unavailable')
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'unavailable',
        })
    })

    it('does not look the sessionToken up when the session record is missing', async () => {
        redis.getdel.mockResolvedValueOnce(TOKEN_DATA)
        redis.get.mockResolvedValueOnce(null)
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'missing',
        })
        expect(checkSessionToken).not.toHaveBeenCalled()
    })

    it('missing when the token is unknown', async () => {
        redis.getdel.mockResolvedValueOnce(null)
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
        redis.getdel.mockResolvedValueOnce(TOKEN_DATA)
        withRedis
            .mockImplementationOnce(async (op) => op())
            .mockRejectedValueOnce(new RedisUnavailableError())
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'unavailable',
        })
    })

    it('missing (logged) on other errors, as before', async () => {
        redis.getdel.mockResolvedValueOnce('{not json')
        await expect(wsSessionAuth.verifyUpgradeToken('t')).resolves.toEqual({
            kind: 'missing',
        })
        expect(logger.error).toHaveBeenCalledTimes(1)
    })
})

// feat-196 (L-12): the token used to be read with GET and kept alive by every message, so it
// opened any number of connections.
describe('the WS token is consumed by the upgrade (feat-196)', () => {
    it('reads the token with GETDEL, never with GET', async () => {
        redis.getdel.mockResolvedValueOnce(TOKEN_DATA)
        redis.get.mockResolvedValueOnce(SESSION_DATA)

        await wsSessionAuth.verifyUpgradeToken('t')

        expect(redis.getdel).toHaveBeenCalledTimes(1)
        expect(redis.getdel).toHaveBeenCalledWith('auth:ws:t')
        expect(redis.get).toHaveBeenCalledTimes(1)
        expect(redis.get).not.toHaveBeenCalledWith('auth:ws:t')
    })

    it('exposes nothing that refreshes or revokes a token', () => {
        expect(Object.keys(wsSessionAuth)).toEqual(['verifyUpgradeToken'])
    })
})

describe('generateWsToken', () => {
    it('rejects with RedisUnavailableError when Redis is down', async () => {
        withRedis.mockRejectedValue(new RedisUnavailableError())
        await expect(
            generateWsToken({ id: 's1', data: { userToken: 'u1' }, createdAt: '' }, '1'),
        ).rejects.toBeInstanceOf(RedisUnavailableError)
        expect(withRedis).toHaveBeenCalledTimes(1)
    })
})
