import { beforeEach, describe, expect, it, vi } from 'vitest'

import csrfGuard from './csrf-guard.js'
import type { HttpContext } from '#vendor/types/types.js'
import csrfConfig from '#config/csrf.js'

const VALID_CSRF_TOKEN = 'a'.repeat(43)

vi.mock('#config/csrf.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    default: {
        enforce: true,
        strictOrigin: false,
        allowedOrigins: ['https://app.example.com'],
        effectiveAllowedOrigins: ['https://app.example.com'],
        headerName: 'x-csrf-token',
    },
}))

interface MutableCsrfConfig {
    enforce: boolean
    strictOrigin: boolean
    effectiveAllowedOrigins: string[]
}
const config = csrfConfig as unknown as MutableCsrfConfig

const createContext = (overrides: Partial<HttpContext> = {}): HttpContext => {
    const context = {
        requestId: 'request-id',
        logger: {
            warn: vi.fn(),
        },
        httpData: {
            method: 'post',
            ip: '127.0.0.1',
            params: {},
            payload: {},
            query: null,
            headers: new Map<string, string>([
                ['origin', 'https://app.example.com'],
                ['x-csrf-token', VALID_CSRF_TOKEN],
            ]),
            contentType: 'application/json',
            cookies: new Map(),
            isJson: true,
            files: null,
            hasFile: vi.fn(() => false),
        },
        responseData: {
            aborted: false,
            payload: null,
            middlewareData: {},
            headers: [],
            cookies: new Map(),
            status: 200,
            deleteCookie: vi.fn(),
            setCookie: vi.fn(),
            setHeader: vi.fn(),
        },
        session: {
            sessionInfo: {
                id: 'session-id',
                data: {
                    csrfToken: VALID_CSRF_TOKEN,
                },
                createdAt: new Date().toISOString(),
            },
            updateSessionData: vi.fn(),
            changeSessionData: vi.fn(),
            destroySession: vi.fn(),
            destroyAllSessions: vi.fn(() => Promise.resolve({ deleted: 0, complete: true })),
        },
        auth: {
            getUserId: vi.fn(() => '7'),
            check: vi.fn(() => true),
            login: vi.fn(),
            logout: vi.fn(),
            logoutAll: vi.fn(() => Promise.resolve({ deleted: 0, complete: true })),
        },
    } as unknown as HttpContext

    return {
        ...context,
        ...overrides,
    }
}

describe('csrfGuard', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        config.enforce = true
        config.strictOrigin = false
        config.effectiveAllowedOrigins = ['https://app.example.com']
    })

    it('allows safe methods without a token', async () => {
        const context = createContext()
        context.httpData.method = 'get'
        context.httpData.headers.delete('x-csrf-token')
        const next = vi.fn()

        await csrfGuard(context, next)

        expect(next).toHaveBeenCalledOnce()
        expect(context.responseData.status).toBe(200)
    })

    it('allows OPTIONS preflight without a token', async () => {
        const context = createContext()
        context.httpData.method = 'options'
        context.httpData.headers.delete('x-csrf-token')
        const next = vi.fn()

        await csrfGuard(context, next)

        expect(next).toHaveBeenCalledOnce()
        expect(context.responseData.status).toBe(200)
    })

    it('rejects unsafe methods without a token', async () => {
        const context = createContext()
        context.httpData.headers.delete('x-csrf-token')
        const next = vi.fn()

        await csrfGuard(context, next)

        expect(next).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe(403)
        expect(context.responseData.payload).toMatchObject({
            status: 'error',
            code: 'csrf_invalid',
            reason: 'token_mismatch',
        })
    })

    it('rejects wrong tokens without throwing on unequal lengths', async () => {
        const context = createContext()
        context.httpData.headers.set('x-csrf-token', 'wrong')
        const next = vi.fn()

        await csrfGuard(context, next)

        expect(next).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe(403)
    })

    it('rejects oversized submitted tokens before timing-safe comparison', async () => {
        const context = createContext()
        context.httpData.headers.set('x-csrf-token', 'a'.repeat(1024))
        const next = vi.fn()

        await csrfGuard(context, next)

        expect(next).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe(403)
        expect(context.responseData.payload).toMatchObject({
            reason: 'token_mismatch',
        })
    })

    it('allows matching tokens', async () => {
        const context = createContext()
        const next = vi.fn()

        await csrfGuard(context, next)

        expect(next).toHaveBeenCalledOnce()
        expect(context.responseData.status).toBe(200)
    })

    it('fails closed when the session layer attached no session', async () => {
        const context = createContext({
            session: {
                ...createContext().session,
                sessionInfo: null,
            },
        })
        const next = vi.fn()

        await csrfGuard(context, next)

        expect(next).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe(403)
        expect(context.responseData.payload).toMatchObject({ reason: 'token_mismatch' })
    })

    it('rejects origin mismatches', async () => {
        const context = createContext()
        context.httpData.headers.set('origin', 'https://evil.example.com')
        const next = vi.fn()

        await csrfGuard(context, next)

        expect(next).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe(403)
        expect(context.responseData.payload).toMatchObject({
            reason: 'origin_mismatch',
        })
    })

    it('reports and allows mismatches when enforcement is disabled', async () => {
        config.enforce = false
        const context = createContext()
        context.httpData.headers.delete('x-csrf-token')
        const next = vi.fn()

        await csrfGuard(context, next)

        expect(next).toHaveBeenCalledOnce()
        expect(context.responseData.status).toBe(200)
        expect(context.logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                reason: 'token_mismatch',
                csrfEnforce: false,
            }),
            'CSRF validation failed',
        )
    })

    describe('Fetch Metadata', () => {
        it.each([['same-origin'], ['same-site'], ['none']])(
            'passes %s on to the next checks',
            async (fetchSite) => {
                const context = createContext()
                context.httpData.headers.set('sec-fetch-site', fetchSite)
                const next = vi.fn()

                await csrfGuard(context, next)

                expect(next).toHaveBeenCalledOnce()
            },
        )

        it('leaves a missing header to the Origin check', async () => {
            const context = createContext()
            context.httpData.headers.set('origin', 'https://evil.example.com')
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).not.toHaveBeenCalled()
            expect(context.responseData.payload).toMatchObject({ reason: 'origin_mismatch' })
        })

        it.each([
            ['cross-site', 'fetch_site_cross_site'],
            ['cross-origin', 'fetch_site_invalid'],
            ['garbage', 'fetch_site_invalid'],
        ])('rejects %s as %s', async (fetchSite, reason) => {
            const context = createContext()
            context.httpData.headers.set('sec-fetch-site', fetchSite)
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).not.toHaveBeenCalled()
            expect(context.responseData.status).toBe(403)
            expect(context.responseData.payload).toMatchObject({ code: 'csrf_invalid', reason })
            expect(context.logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ reason, secFetchSite: fetchSite }),
                'CSRF validation failed',
            )
        })

        it('rejects cross-site even from an allowed origin', async () => {
            const context = createContext()
            context.httpData.headers.set('sec-fetch-site', 'cross-site')
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).not.toHaveBeenCalled()
        })

        it('does not let same-origin skip the token check', async () => {
            const context = createContext()
            context.httpData.headers.set('sec-fetch-site', 'same-origin')
            context.httpData.headers.set('x-csrf-token', 'b'.repeat(43))
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).not.toHaveBeenCalled()
            expect(context.responseData.payload).toMatchObject({ reason: 'token_mismatch' })
        })

        it('only logs and continues when enforcement is disabled', async () => {
            config.enforce = false
            const context = createContext()
            context.httpData.headers.set('sec-fetch-site', 'cross-site')
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).toHaveBeenCalledOnce()
            expect(context.responseData.status).toBe(200)
            expect(context.logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ reason: 'fetch_site_cross_site', csrfEnforce: false }),
                'CSRF validation failed',
            )
        })
    })

    describe('Origin and Referer', () => {
        it.each([
            ['null'],
            ['not a url'],
            ['https://app.example.com/'],
            ['https://app.example.com/x'],
        ])('rejects Origin %j without falling back to Referer', async (origin) => {
            const context = createContext()
            context.httpData.headers.set('origin', origin)
            context.httpData.headers.set('referer', 'https://app.example.com/page')
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).not.toHaveBeenCalled()
            expect(context.responseData.payload).toMatchObject({ reason: 'origin_mismatch' })
        })

        it('rejects Origin null even with an empty allowlist', async () => {
            config.effectiveAllowedOrigins = []
            const context = createContext()
            context.httpData.headers.set('origin', 'null')
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).not.toHaveBeenCalled()
        })

        it('accepts any well-formed origin with an empty allowlist', async () => {
            config.effectiveAllowedOrigins = []
            const context = createContext()
            context.httpData.headers.set('origin', 'https://other.example.com')
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).toHaveBeenCalledOnce()
        })

        it('falls back to an allowed Referer when Origin is absent', async () => {
            const context = createContext()
            context.httpData.headers.delete('origin')
            context.httpData.headers.set('referer', 'https://app.example.com/account')
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).toHaveBeenCalledOnce()
        })

        it('rejects an unparsable Referer', async () => {
            const context = createContext()
            context.httpData.headers.delete('origin')
            context.httpData.headers.set('referer', 'nonsense')
            const next = vi.fn()

            await csrfGuard(context, next)

            expect(next).not.toHaveBeenCalled()
            expect(context.responseData.payload).toMatchObject({ reason: 'origin_mismatch' })
        })

        it.each([
            [true, false],
            [false, true],
        ])(
            'with strictOrigin=%s a request without Origin and Referer passes: %s',
            async (strict, passes) => {
                config.strictOrigin = strict
                const context = createContext()
                context.httpData.headers.delete('origin')
                const next = vi.fn()

                await csrfGuard(context, next)

                expect(next).toHaveBeenCalledTimes(passes ? 1 : 0)
            },
        )
    })
})
