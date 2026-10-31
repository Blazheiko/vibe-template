import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'

const logger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))

const getSession = vi.hoisted(() => vi.fn())
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    getSession,
    saveSession: vi.fn(),
    updateSessionData: vi.fn(),
    changeSessionData: vi.fn(),
    destroySession: vi.fn(),
    destroyAllSessions: vi.fn(),
}))

// Signed cookies are not used by wsSessionHandler (and need APP_KEY).
vi.mock('#vendor/utils/session/token-handler.js', () => ({
    createSignedToken: vi.fn(),
    verifySignedToken: vi.fn(),
}))

const { wsSessionHandler } = await import('./session-handler.js')
const { registerSessionTokenChecker } = await import('./session-token-check.js')

const tokenChecker = vi.fn()
registerSessionTokenChecker(tokenChecker)

const USER_TOKEN = 'abcdef0123456789'

beforeEach(() => {
    vi.clearAllMocks()
    tokenChecker.mockResolvedValue('ok')
})

describe('wsSessionHandler', () => {
    it('ok with the session of an authenticated user', async () => {
        getSession.mockResolvedValue({ id: 's1', data: { userId: '1' }, createdAt: '' })
        const result = await wsSessionHandler('s1', USER_TOKEN)
        expect(result.kind).toBe('ok')
        expect(result.kind === 'ok' && result.session.sessionInfo?.id).toBe('s1')
    })

    // ADR 0002: the record is there, but users.sessionToken was rotated.
    it('missing when the sessionToken was rotated, though the session record exists', async () => {
        getSession.mockResolvedValue({ id: 's1', data: { userId: '1' }, createdAt: '' })
        tokenChecker.mockResolvedValue('mismatch')
        await expect(wsSessionHandler('s1', USER_TOKEN)).resolves.toEqual({ kind: 'missing' })
        expect(tokenChecker).toHaveBeenCalledWith('1', USER_TOKEN)
    })

    it('unavailable when the sessionToken lookup fails: the message is not served', async () => {
        getSession.mockResolvedValue({ id: 's1', data: { userId: '1' }, createdAt: '' })
        tokenChecker.mockResolvedValue('unavailable')
        await expect(wsSessionHandler('s1', USER_TOKEN)).resolves.toEqual({
            kind: 'unavailable',
        })
    })

    it('missing when there is no session', async () => {
        getSession.mockResolvedValue(null)
        await expect(wsSessionHandler('s1', USER_TOKEN)).resolves.toEqual({
            kind: 'missing',
        })
    })

    it('unavailable on RedisUnavailableError, without an error log', async () => {
        getSession.mockRejectedValue(new RedisUnavailableError())
        await expect(wsSessionHandler('s1', USER_TOKEN)).resolves.toEqual({
            kind: 'unavailable',
        })
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('missing with an error log on other errors, as before', async () => {
        getSession.mockRejectedValue(new Error('boom'))
        await expect(wsSessionHandler('s1', USER_TOKEN)).resolves.toEqual({
            kind: 'missing',
        })
        expect(logger.error).toHaveBeenCalledTimes(1)
    })
})
