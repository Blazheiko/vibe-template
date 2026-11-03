import { describe, expect, it, vi } from 'vitest'

const info = vi.fn()
vi.mock('#vendor/utils/logger.js', () => ({
    default: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('#config/redis.js', () => ({
    default: { keyPrefix: 'test:', commandTimeoutMs: 500, logoutAllDeadlineMs: 2000 },
}))
vi.mock('#database/redis.js', () => ({
    default: {
        scan: vi.fn(async () => ['0', ['test:session:tok:1', 'test:session:tok:2']]),
        del: vi.fn(async () => 2),
    },
    withRedis: async <T>(op: () => Promise<T>): Promise<T> => op(),
}))

const { destroyAllSessions } = await import('./redis-session-storage.js')

const USER_TOKEN = 'abcdef0123456789abcdef0123456789'

describe('destroyAllSessions logging', () => {
    it('logs only a masked userToken and no Redis pattern', async () => {
        await expect(destroyAllSessions(USER_TOKEN)).resolves.toEqual({
            deleted: 2,
            complete: true,
        })

        const logged = JSON.stringify(info.mock.calls)
        expect(info).toHaveBeenCalledTimes(2)
        expect(logged).not.toContain(USER_TOKEN)
        expect(logged).not.toContain('session:')
        expect(logged).toContain('abcd…')
    })
})
