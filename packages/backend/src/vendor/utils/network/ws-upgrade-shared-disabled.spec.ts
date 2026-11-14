import { describe, expect, it, vi } from 'vitest'

import appConfig from '#config/app.js'

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
// WS_UPGRADE_SHARED_RATE_LIMIT_MAX=0
vi.mock('#config/throttle-policies.js', () => ({
    throttlePolicies: {
        wsUpgradeShared: { scope: 'upgrade', limit: 0, windowMs: 60_000 },
    },
}))
const evalMock = vi.fn()
vi.mock('#database/redis-rate-limit.js', () => ({
    default: { eval: evalMock },
}))
vi.mock('../routing/ws-api-dispatcher.js', () => ({ default: vi.fn() }))
vi.mock('../session/session-handler.js', () => ({ wsSessionHandler: vi.fn() }))
vi.mock('./get-ip.js', () => ({ default: () => '10.4.0.1' }))

describe('handleUpgrade with level 2 disabled', () => {
    it('never calls Redis and still answers 429 from level 1', async () => {
        const handlers = await import('./ws-handlers.js')
        handlers.registerWsAppHooks({
            onUpgrade: vi
                .fn()
                .mockResolvedValue({ kind: 'ok', sessionId: 's1', userId: '1', userToken: 'u1' }),
            onConnected: vi.fn(),
            onDisconnected: vi.fn(),
        })
        const statuses: string[] = []
        const token = 'a'.repeat(appConfig.accessTokenLength)
        for (let i = 0; i < 3; i++) {
            let status = ''
            const res = {
                onAborted: () => res,
                cork: (cb: () => void) => {
                    cb()
                    return res
                },
                writeStatus: (s: string) => {
                    status = s
                    return res
                },
                writeHeader: () => res,
                end: () => res,
                upgrade: () => {
                    status = 'upgraded'
                },
                getProxiedRemoteAddressAsText: () => new ArrayBuffer(0),
            }
            await handlers.handleUpgrade(
                res as never,
                {
                    getHeader: (n: string) =>
                        n === 'sec-websocket-protocol' ? `${token}, web` : '',
                } as never,
                {},
            )
            statuses.push(status)
        }
        expect(statuses).toEqual(['upgraded', 'upgraded', '429 Too Many Requests'])
        expect(evalMock).not.toHaveBeenCalled()
    })
})
