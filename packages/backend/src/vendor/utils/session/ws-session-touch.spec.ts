import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserConnection } from '#vendor/types/types.js'

const touchSession = vi.hoisted(() => vi.fn())
const warn = vi.hoisted(() => vi.fn())
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({ touchSession }))
vi.mock('#vendor/utils/logger.js', () => ({ default: { warn, info: vi.fn(), error: vi.fn() } }))

const { touchSessionFromWs, WS_TOUCH_INTERVAL_MS } = await import('./ws-session-touch.js')

const connection = (): UserConnection =>
    ({ uuid: 'u-1', sessionId: 's-1', userToken: 't-1' }) as unknown as UserConnection

beforeEach(() => {
    vi.clearAllMocks()
    touchSession.mockResolvedValue(true)
})

describe('lastSeenAt from WebSocket messages (feat-233, Р4)', () => {
    it('writes on the first message, then at most once per interval', async () => {
        const userData = connection()
        await touchSessionFromWs(userData, 1_000)
        await touchSessionFromWs(userData, 1_000 + WS_TOUCH_INTERVAL_MS - 1)
        expect(touchSession).toHaveBeenCalledTimes(1)
        expect(touchSession).toHaveBeenCalledWith('s-1', 't-1', 1_000)
        await touchSessionFromWs(userData, 1_000 + WS_TOUCH_INTERVAL_MS)
        expect(touchSession).toHaveBeenCalledTimes(2)
    })

    it('after a failed write the next message tries again; the warning is rate limited', async () => {
        const userData = connection()
        touchSession.mockRejectedValue(new Error('redis down'))
        await touchSessionFromWs(userData, 1_000)
        await touchSessionFromWs(userData, 2_000)
        expect(touchSession).toHaveBeenCalledTimes(2)
        expect(warn).toHaveBeenCalledTimes(1)
        await touchSessionFromWs(userData, 62_000)
        expect(warn).toHaveBeenCalledTimes(2)

        touchSession.mockResolvedValue(true)
        await touchSessionFromWs(userData, 63_000)
        await touchSessionFromWs(userData, 64_000)
        expect(touchSession).toHaveBeenCalledTimes(4)
    })

    it('one write at a time per connection', async () => {
        const userData = connection()
        let release: (v: boolean) => void = () => undefined
        touchSession.mockReturnValue(new Promise<boolean>((resolve) => (release = resolve)))
        const first = touchSessionFromWs(userData, 1_000)
        await touchSessionFromWs(userData, 1_001)
        release(true)
        await first
        expect(touchSession).toHaveBeenCalledTimes(1)
    })

    it('a connection without a session writes nothing', async () => {
        await touchSessionFromWs({ uuid: 'x' } as unknown as UserConnection)
        expect(touchSession).not.toHaveBeenCalled()
    })
})
