import { beforeEach, describe, expect, it, vi } from 'vitest'

import appConfig from '#config/app.js'

// feat-197 (security review 2026-11-12, M-4): the upgrade refuses a connection over the limit
// of its user or of its address with 429, and onClose gives the place back.
const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('../routing/ws-api-dispatcher.js', () => ({ default: vi.fn() }))
vi.mock('../session/session-handler.js', () => ({ wsSessionHandler: vi.fn() }))
vi.mock('#vendor/utils/rate-limit/upgrade-rate-limit.js', () => ({
    default: () => ({ kind: 'allowed' }),
    checkUpgradeRateLimitShared: () => Promise.resolve({ kind: 'allowed' }),
}))
vi.mock('#config/websocket.js', () => ({
    default: {
        messagesPerMinute: 120,
        maxConcurrentHandlers: 8,
        maxConnectionsPerUser: 2,
        maxConnectionsPerIp: 3,
    },
}))
const ip = vi.hoisted(() => ({ value: '10.7.0.1' }))
vi.mock('./get-ip.js', () => ({ default: () => ip.value }))

const onUpgrade = vi.fn()
const onDisconnected = vi.fn(() => Promise.resolve())
const handlers = await import('./ws-handlers.js')
const { __resetWsConnectionLimitForTests } =
    await import('#vendor/utils/rate-limit/ws-connection-limit.js')
handlers.registerWsAppHooks({ onUpgrade, onConnected: vi.fn(), onDisconnected })

const VALID_TOKEN = 'a'.repeat(appConfig.accessTokenLength)
const req = {
    getHeader: (name: string) => (name === 'sec-websocket-protocol' ? `${VALID_TOKEN}, web` : ''),
}

interface Upgraded {
    status: string | null
    headers: Record<string, string>
    userData: Record<string, unknown> | null
}

/** One upgrade request; `userData` is what uWS would hand to the open socket. */
const upgrade = async (userId: string, upgradeThrows = false): Promise<Upgraded> => {
    onUpgrade.mockResolvedValueOnce({ kind: 'ok', sessionId: 's1', userId, userToken: 'u1' })
    const outcome: Upgraded = { status: null, headers: {}, userData: null }
    const res = {
        onAborted: () => res,
        cork: (cb: () => void) => {
            cb()
            return res
        },
        writeStatus: (status: string) => {
            outcome.status = status
            return res
        },
        writeHeader: (name: string, value: string) => {
            outcome.headers[name] = value
            return res
        },
        end: () => res,
        upgrade: (userData: Record<string, unknown>) => {
            if (upgradeThrows) throw new Error('upgrade failed')
            outcome.userData = userData
        },
        getProxiedRemoteAddressAsText: () => new ArrayBuffer(0),
    }
    await handlers.handleUpgrade(res as never, req as never, {})
    return outcome
}

const close = async (userData: Record<string, unknown> | null): Promise<void> => {
    if (userData === null) throw new Error('the upgrade was refused')
    await handlers.onClose({ getUserData: () => userData } as never, 1000, new ArrayBuffer(0))
}

beforeEach(() => {
    vi.clearAllMocks()
    __resetWsConnectionLimitForTests()
    handlers.__acceptUpgradesForTests()
    ip.value = '10.7.0.1'
})

describe('WebSocket upgrade: the limit of open connections', () => {
    it('refuses the connection over the limit of its user with 429 and Retry-After', async () => {
        expect((await upgrade('1')).userData).not.toBeNull()
        expect((await upgrade('1')).userData).not.toBeNull()

        const refused = await upgrade('1')

        expect(refused.userData).toBeNull()
        expect(refused.status).toBe('429 Too Many Requests')
        expect(refused.headers['Retry-After']).toBe('5')
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ userId: '1', by: 'user' }),
            'WebSocket upgrade refused: too many open connections',
        )
    })

    it('counts the user across addresses', async () => {
        await upgrade('1')
        ip.value = '10.7.0.2'
        await upgrade('1')
        ip.value = '10.7.0.3'

        expect((await upgrade('1')).status).toBe('429 Too Many Requests')
    })

    it('refuses the connection over the limit of its address, whoever the user is', async () => {
        await upgrade('1')
        await upgrade('2')
        await upgrade('3')

        const refused = await upgrade('4')

        expect(refused.status).toBe('429 Too Many Requests')
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ userId: '4', by: 'ip' }),
            'WebSocket upgrade refused: too many open connections',
        )
        // Another address is not affected.
        ip.value = '10.7.0.9'
        expect((await upgrade('4')).userData).not.toBeNull()
    })

    it('lets the next connection in once one has closed', async () => {
        const first = await upgrade('1')
        await upgrade('1')
        expect((await upgrade('1')).status).toBe('429 Too Many Requests')

        await close(first.userData)

        expect((await upgrade('1')).userData).not.toBeNull()
        expect((await upgrade('1')).status).toBe('429 Too Many Requests')
    })

    it('gives a place back once, even if the close handler runs twice', async () => {
        const first = await upgrade('1')
        await upgrade('1')

        await close(first.userData)
        await close(first.userData)

        expect((await upgrade('1')).userData).not.toBeNull()
        expect((await upgrade('1')).status).toBe('429 Too Many Requests')
    })

    it('a refused upgrade takes no place', async () => {
        const first = await upgrade('1')
        const second = await upgrade('1')
        await upgrade('1')
        await upgrade('1')

        await close(first.userData)
        await close(second.userData)

        // Both places are free again: the two refusals left nothing behind.
        expect((await upgrade('1')).userData).not.toBeNull()
        expect((await upgrade('1')).userData).not.toBeNull()
    })

    it('gives the place back when res.upgrade throws', async () => {
        const failed = await upgrade('1', true)
        expect(failed.status).toBe('500 Internal Server Error')

        expect((await upgrade('1')).userData).not.toBeNull()
        expect((await upgrade('1')).userData).not.toBeNull()
    })
})
