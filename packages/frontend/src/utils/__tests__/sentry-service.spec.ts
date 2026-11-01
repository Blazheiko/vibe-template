import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { App } from 'vue'
import type { Router } from 'vue-router'

const sentryMocks = vi.hoisted(() => {
    interface ScopeMock {
        setTag: ReturnType<typeof vi.fn>
        setExtra: ReturnType<typeof vi.fn>
        setUser: ReturnType<typeof vi.fn>
    }

    const scope = {
        setTag: vi.fn(),
        setExtra: vi.fn(),
        setUser: vi.fn(),
    } satisfies ScopeMock

    return {
        scope,
        init: vi.fn(),
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        setUser: vi.fn(),
        flush: vi.fn().mockResolvedValue(true),
        withScope: vi.fn((callback: (scope: ScopeMock) => unknown) => callback(scope)),
        browserTracingIntegration: vi.fn(() => ({ name: 'browserTracingIntegration' })),
        replayIntegration: vi.fn(() => ({ name: 'replayIntegration' })),
    }
})

vi.mock('@sentry/vue', () => sentryMocks)

const loadService = async () => {
    const serviceModule = await import('@/utils/sentry-service')
    return serviceModule.sentryService
}

const loadConfig = async () => {
    const configModule = await import('@/utils/sentry-config')
    return configModule.sentryConfig
}

const createRouterMock = (path = '/account', name: string | symbol | null = 'UserAccount') =>
    ({
        currentRoute: ref({
            path,
            fullPath: path,
            name,
        }),
    }) as unknown as Router

const createAppMock = () => ({}) as App

describe('sentry config', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.unstubAllEnvs()
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('falls back to 0 for invalid trace sample rate and warns once', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/1')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'true')
        vi.stubEnv('VITE_SENTRY_TRACES_SAMPLE_RATE', 'not-a-number')

        const config = await loadConfig()

        expect(config.tracesSampleRate).toBe(0)
        expect(warnSpy).toHaveBeenCalledTimes(1)

        warnSpy.mockRestore()
    })
})

describe('sentry service', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.unstubAllEnvs()
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('is a no-op when DSN is unset', async () => {
        vi.stubEnv('VITE_SENTRY_DSN', '')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'true')

        const sentryService = await loadService()
        sentryService.init(createAppMock(), createRouterMock())

        expect(sentryService.isEnabled()).toBe(false)
        await expect(sentryService.flush(2000)).resolves.toBe(true)

        sentryService.captureException(new Error('boom'))
        sentryService.captureMessage('boom')
        sentryService.setUser({ id: '123' })

        expect(sentryMocks.init).not.toHaveBeenCalled()
        expect(sentryMocks.captureException).not.toHaveBeenCalled()
        expect(sentryMocks.captureMessage).not.toHaveBeenCalled()
        expect(sentryMocks.setUser).not.toHaveBeenCalled()
    })

    it('is a no-op when the kill switch is false', async () => {
        vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/2')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'false')

        const sentryService = await loadService()
        sentryService.init(createAppMock(), createRouterMock())

        expect(sentryService.isEnabled()).toBe(false)
        expect(sentryMocks.init).not.toHaveBeenCalled()
    })

    it('attaches route, routeName, locale, tags, and extra when capturing exceptions', async () => {
        vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/3')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'true')

        const { i18n } = await import('@/plugins/i18n')
        i18n.global.locale.value = 'uk'

        const sentryService = await loadService()
        sentryService.init(createAppMock(), createRouterMock('/account', 'UserAccount'))
        sentryService.captureException(new Error('boom'), {
            tags: { intent: 'submit-form' },
            extra: { foo: 'bar' },
        })

        expect(sentryMocks.captureException).toHaveBeenCalledTimes(1)
        expect(sentryMocks.scope.setTag).toHaveBeenCalledWith('route', '/account')
        expect(sentryMocks.scope.setTag).toHaveBeenCalledWith('routeName', 'UserAccount')
        expect(sentryMocks.scope.setTag).toHaveBeenCalledWith('locale', 'uk')
        expect(sentryMocks.scope.setTag).toHaveBeenCalledWith('intent', 'submit-form')
        expect(sentryMocks.scope.setExtra).toHaveBeenCalledWith('foo', 'bar')
    })

    it('disables personal and payload data collection (Sentry 11 defaults collect it)', async () => {
        vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/4')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'true')

        const sentryService = await loadService()
        sentryService.init(createAppMock(), createRouterMock())

        expect(sentryMocks.init).toHaveBeenCalledWith(
            expect.objectContaining({
                dataCollection: expect.objectContaining({
                    userInfo: false,
                    cookies: false,
                    httpBodies: [],
                }),
            }),
        )
    })

    it('sanitizes events and breadcrumbs before send', async () => {
        vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/4')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'true')

        const sentryService = await loadService()
        sentryService.init(createAppMock(), createRouterMock())

        const initOptions = sentryMocks.init.mock.calls[0]?.[0]
        expect(initOptions).toBeDefined()

        const beforeSend = initOptions.beforeSend as (
            event: Record<string, unknown>,
        ) => Record<string, unknown>
        const beforeBreadcrumb = initOptions.beforeBreadcrumb as (
            breadcrumb: Record<string, unknown> | null,
        ) => Record<string, unknown> | null

        const event = beforeSend({
            user: {
                id: 42,
                email: 'user@example.com',
                username: 'demo',
            },
            request: {
                url: 'https://example.com/api?token=secret&state=abc',
                headers: {
                    Authorization: 'Bearer abc',
                    Cookie: 'session=abc',
                    Accept: 'application/json',
                },
                data: {
                    password: 'hunter2',
                    token: 'secret',
                    nested: {
                        api_key: 'should-drop',
                        safe: 'keep',
                    },
                },
            },
        })

        expect(event.user).toEqual({ id: '42' })
        expect((event.request as Record<string, unknown>).url).toContain('%5BFiltered%5D')
        expect((event.request as Record<string, unknown>).headers).toEqual({
            Authorization: '[Filtered]',
            Cookie: '[Filtered]',
            Accept: 'application/json',
        })
        expect((event.request as Record<string, unknown>).data).toEqual({
            nested: {
                safe: 'keep',
            },
        })

        const breadcrumb = beforeBreadcrumb({
            category: 'navigation',
            data: {
                url: 'https://example.com/path?token=secret&code=123',
                from: 'https://example.com/from?state=1',
                headers: {
                    Authorization: 'Bearer abc',
                    Cookie: 'sid=abc',
                },
            },
        })

        expect((breadcrumb?.data as Record<string, unknown>).url).toContain('%5BFiltered%5D')
        expect((breadcrumb?.data as Record<string, unknown>).from).toContain('%5BFiltered%5D')
        expect((breadcrumb?.data as Record<string, unknown>).headers).toEqual({
            Authorization: '[Filtered]',
            Cookie: '[Filtered]',
        })
    })

    // feat-075 (I): request data and breadcrumb data share one walker; they differ only in what
    // happens to a sensitive key (dropped from the request, kept as "[Filtered]" in a breadcrumb).
    it('treats a sensitive key by where it is: dropped in request data, filtered in breadcrumbs', async () => {
        vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/4')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'true')

        const sentryService = await loadService()
        sentryService.init(createAppMock(), createRouterMock())

        const initOptions = sentryMocks.init.mock.calls[0]?.[0]
        const beforeSend = initOptions.beforeSend as (
            event: Record<string, unknown>,
        ) => Record<string, unknown>
        const beforeBreadcrumb = initOptions.beforeBreadcrumb as (
            breadcrumb: Record<string, unknown> | null,
        ) => Record<string, unknown> | null

        const data = {
            list: [{ password: 'p', ok: 1 }, 'text', null, 7],
            nested: {
                api_key: 'k',
                refreshToken: 't',
                safe: 'keep',
                href: 'https://x.test/?code=1',
            },
        }

        const breadcrumb = beforeBreadcrumb({ category: 'x', data })
        expect(breadcrumb?.data).toEqual({
            list: [{ password: '[Filtered]', ok: 1 }, 'text', null, 7],
            nested: {
                api_key: '[Filtered]',
                refreshToken: '[Filtered]',
                safe: 'keep',
                href: expect.stringContaining('%5BFiltered%5D'),
            },
        })

        const event = beforeSend({ request: { data } })
        expect((event.request as Record<string, unknown>).data).toEqual({
            list: [{ ok: 1 }, 'text', null, 7],
            nested: { safe: 'keep', href: expect.stringContaining('%5BFiltered%5D') },
        })

        // A breadcrumb that reaches the event unfiltered is cleaned once more at send.
        const sent = beforeSend({ breadcrumbs: [{ category: 'x', data: { token: 't', safe: 1 } }] })
        expect((sent.breadcrumbs as { data: unknown }[])[0]?.data).toEqual({
            token: '[Filtered]',
            safe: 1,
        })
    })

    it('forwards only the user id when setting user context', async () => {
        vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/5')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'true')

        const sentryService = await loadService()
        sentryService.init(createAppMock(), createRouterMock())
        sentryService.setUser({ id: '123' })

        expect(sentryMocks.setUser).toHaveBeenCalledWith({ id: '123' })
    })

    it('emits replay integration only when replay sample rates are enabled', async () => {
        vi.stubEnv('VITE_SENTRY_DSN', 'https://example.invalid/6')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'true')
        vi.stubEnv('VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE', '0.1')
        vi.stubEnv('VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE', '0')

        const sentryService = await loadService()
        sentryService.init(createAppMock(), createRouterMock())

        expect(sentryMocks.replayIntegration).toHaveBeenCalledTimes(1)
    })
})
