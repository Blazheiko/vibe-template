import { beforeEach, describe, expect, it, vi } from 'vitest'

import appConfig from '#config/app.js'

vi.mock('#vendor/utils/logger.js', () => ({
    default: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('../routing/ws-api-dispatcher.js', () => ({ default: vi.fn() }))
vi.mock('../session/session-handler.js', () => ({ wsSessionHandler: vi.fn() }))
vi.mock('./get-ip.js', () => ({ default: () => '10.3.0.1' }))

type Result =
    { kind: 'allowed' } | { kind: 'limited'; retryAfter: number } | { kind: 'unavailable' }

const local = vi.fn<() => Result>()
const shared = vi.fn<() => Promise<Result>>()
vi.mock('#vendor/utils/rate-limit/upgrade-rate-limit.js', () => ({
    default: local,
    checkUpgradeRateLimitShared: shared,
}))

const onUpgrade = vi.fn()
const VALID_TOKEN = 'a'.repeat(appConfig.accessTokenLength)

const createRes = () => {
    let abort: () => void = () => {}
    const calls: string[] = []
    const res = {
        onAborted: (cb: () => void) => {
            abort = cb
            return res
        },
        cork: (cb: () => void) => {
            calls.push('cork')
            cb()
            return res
        },
        writeStatus: (status: string) => {
            calls.push(`status:${status}`)
            return res
        },
        writeHeader: (name: string, value: string) => {
            calls.push(`header:${name}=${value}`)
            return res
        },
        end: () => {
            calls.push('end')
            return res
        },
        upgrade: () => {
            calls.push('upgrade')
        },
        getProxiedRemoteAddressAsText: () => new ArrayBuffer(0),
    }
    return {
        res,
        calls,
        abort: () => {
            abort()
        },
    }
}

const req = {
    getHeader: (name: string) => (name === 'sec-websocket-protocol' ? `${VALID_TOKEN}, web` : ''),
}

const load = async () => {
    const handlers = await import('./ws-handlers.js')
    handlers.registerWsAppHooks({
        onUpgrade,
        onConnected: vi.fn(),
        onDisconnected: vi.fn(),
    })
    return handlers.handleUpgrade
}

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    local.mockReturnValue({ kind: 'allowed' })
    shared.mockResolvedValue({ kind: 'allowed' })
    onUpgrade.mockResolvedValue({
        kind: 'ok',
        sessionId: 's',
        userId: '1',
        userToken: 'u',
    })
})

describe('handleUpgrade: level 1 → level 2 → auth', () => {
    it('does not reach Redis when level 1 rejects', async () => {
        local.mockReturnValue({ kind: 'limited', retryAfter: 60 })
        const handleUpgrade = await load()
        const { res, calls } = createRes()
        await handleUpgrade(res as never, req as never, {})
        expect(shared).not.toHaveBeenCalled()
        expect(calls).toContain('status:429 Too Many Requests')
        expect(onUpgrade).not.toHaveBeenCalled()
    })

    it('answers 429 from level 2 before the session lookup', async () => {
        shared.mockResolvedValue({ kind: 'limited', retryAfter: 7 })
        const handleUpgrade = await load()
        const { res, calls } = createRes()
        await handleUpgrade(res as never, req as never, {})
        expect(calls).toEqual([
            'cork',
            'status:429 Too Many Requests',
            'header:Retry-After=7',
            'end',
        ])
        expect(onUpgrade).not.toHaveBeenCalled()
    })

    it('corks the 401 for an invalid token written after the level 2 await', async () => {
        const handleUpgrade = await load()
        const { res, calls } = createRes()
        const badReq = {
            getHeader: (name: string) => (name === 'sec-websocket-protocol' ? 'bad, web' : ''),
        }
        await handleUpgrade(res as never, badReq as never, {})
        expect(calls).toEqual(['cork', 'status:401 Unauthorized', 'end'])
        expect(onUpgrade).not.toHaveBeenCalled()
    })

    it('upgrades when both levels allow (incl. a skipped level 2)', async () => {
        const handleUpgrade = await load()
        const { res, calls } = createRes()
        await handleUpgrade(res as never, req as never, {})
        expect(onUpgrade).toHaveBeenCalledTimes(1)
        expect(calls).toContain('upgrade')
    })

    it.each([
        ['allowed', { kind: 'allowed' }],
        ['limited', { kind: 'limited', retryAfter: 5 }],
    ] as const)(
        'writes nothing to res when the client aborts during level 2 (%s)',
        async (_name, result) => {
            let release: (value: Result) => void = () => {}
            shared.mockReturnValue(new Promise<Result>((resolve) => (release = resolve)))
            const handleUpgrade = await load()
            const { res, calls, abort } = createRes()
            const pending = handleUpgrade(res as never, req as never, {})
            abort()
            release(result)
            await pending
            expect(calls).toEqual([])
            expect(onUpgrade).not.toHaveBeenCalled()
        },
    )
})
