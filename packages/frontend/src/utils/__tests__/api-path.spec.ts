import { afterEach, describe, expect, it, vi } from 'vitest'

// HTTP paths follow VITE_API_PATH_PREFIX like WS events (code-issues item 73).
afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.doUnmock('../base-api')
})

describe('apiPath', () => {
    it('builds /<prefix>/<route> and defaults to api', async () => {
        const { apiPath, normalizeApiPrefix } = await import('../api-path')
        expect(apiPath('auth/login')).toBe('/api/auth/login')
        expect(apiPath('/auth/login', 'v1')).toBe('/v1/auth/login')
        expect(normalizeApiPrefix(' /v1/ ')).toBe('v1')
    })

    it('api.ts calls go under the configured prefix', async () => {
        vi.stubEnv('VITE_API_PATH_PREFIX', 'v1')
        const http = vi.fn().mockResolvedValue({ data: null, error: null })
        vi.doMock('../base-api', () => ({ default: { http } }))
        const { authApi } = await import('../api')

        await authApi.login({ identifier: 'a@b.c', password: 'password1' })

        expect(http).toHaveBeenCalledWith('POST', '/v1/auth/login', expect.anything(), {
            csrfRecovery: 'public',
        })
    })
})
