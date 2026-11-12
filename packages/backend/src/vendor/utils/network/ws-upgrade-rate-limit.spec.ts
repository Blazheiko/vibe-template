import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('#vendor/utils/logger.js', () => ({
    default: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('#config/rate-limit.js', () => ({
    default: {
        httpGlobal: { windowMs: 60_000, max: 100 },
        wsUpgrade: { windowMs: 60_000, max: 2 },
        configError: null,
    },
}))
// Level 2 (Redis) is covered in ws-upgrade-shared-limit.spec.ts; here it always allows.
vi.mock('#database/redis-rate-limit.js', () => ({
    default: { eval: vi.fn().mockResolvedValue([1, 1, 0]) },
}))
vi.mock('../routing/ws-api-dispatcher.js', () => ({ default: vi.fn() }))
vi.mock('../session/session-handler.js', () => ({ wsSessionHandler: vi.fn() }))

let currentIp = '10.2.0.1'
vi.mock('./get-ip.js', () => ({ default: () => currentIp }))

const onUpgrade = vi.fn()

const load = async () => {
    const handlers = await import('./ws-handlers.js')
    handlers.registerWsAppHooks({
        onUpgrade,
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
    })
    return handlers.handleUpgrade
}

const createRes = () => {
    const captured = {
        status: '',
        headers: [] as { name: string; value: string }[],
        upgraded: false,
    }
    const res = {
        onAborted: () => res,
        cork: (callback: () => void) => {
            callback()
            return res
        },
        writeStatus: (status: string) => {
            captured.status = status
            return res
        },
        writeHeader: (name: string, value: string) => {
            captured.headers.push({ name, value })
            return res
        },
        end: () => res,
        upgrade: () => {
            captured.upgraded = true
        },
        getProxiedRemoteAddressAsText: () => new ArrayBuffer(0),
    }
    return { res, captured }
}

const createReq = (token: string) => ({
    getHeader: (name: string) => (name === 'sec-websocket-protocol' ? `${token}, web` : ''),
})

import appConfig from '#config/app.js'

const VALID_TOKEN = 'a'.repeat(appConfig.accessTokenLength)

const upgrade = async (token: string) => {
    const handleUpgrade = await load()
    const { res, captured } = createRes()
    await handleUpgrade(res as never, createReq(token) as never, {})
    return captured
}

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useRealTimers()
    onUpgrade.mockResolvedValue({
        kind: 'ok',
        sessionId: 's',
        userId: '1',
        userToken: 'u',
    })
})

describe('handleUpgrade rate limit', () => {
    it('upgrades while under the limit', async () => {
        currentIp = '10.2.0.1'
        const captured = await upgrade(VALID_TOKEN)
        expect(captured.upgraded).toBe(true)
        expect(onUpgrade).toHaveBeenCalledTimes(1)
    })

    it('answers 429 with Retry-After and skips the session lookup', async () => {
        currentIp = '10.2.0.2'
        await upgrade('bad')
        await upgrade('bad')
        const captured = await upgrade(VALID_TOKEN)

        expect(captured.status).toBe('429 Too Many Requests')
        expect(captured.headers).toEqual([{ name: 'Retry-After', value: '60' }])
        expect(captured.upgraded).toBe(false)
        expect(onUpgrade).not.toHaveBeenCalled()
    })

    it('counts invalid tokens: they get 401 but use the budget', async () => {
        currentIp = '10.2.0.3'
        expect((await upgrade('bad')).status).toBe('401 Unauthorized')
        expect((await upgrade('bad')).status).toBe('401 Unauthorized')
        expect((await upgrade('bad')).status).toBe('429 Too Many Requests')
    })

    it('limits per IP', async () => {
        currentIp = '10.2.0.4'
        await upgrade('bad')
        await upgrade('bad')
        currentIp = '10.2.0.5'
        expect((await upgrade('bad')).status).toBe('401 Unauthorized')
    })

    it('answers 503 when the limiter fails', async () => {
        const { rateLimitStore } = await import('#vendor/utils/rate-limit/rate-limit-store.js')
        vi.spyOn(rateLimitStore, 'consume').mockImplementationOnce(() => {
            throw new Error('boom')
        })
        currentIp = '10.2.0.6'
        const captured = await upgrade(VALID_TOKEN)
        expect(captured.status).toBe('503 Service Unavailable')
        expect(captured.upgraded).toBe(false)
    })

    it('lets upgrades through again after the window', async () => {
        vi.useFakeTimers({ now: 5_000_000 })
        currentIp = '10.2.0.7'
        await upgrade('bad')
        await upgrade('bad')
        expect((await upgrade('bad')).status).toBe('429 Too Many Requests')
        vi.advanceTimersByTime(60_000)
        expect((await upgrade('bad')).status).toBe('401 Unauthorized')
    })
})
