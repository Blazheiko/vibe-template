import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

// Security review of main at 68789d6: with tracing on, the real Sentry Vue router integration
// copies `query.token` into the navigation span and `beforeSend` never sees spans. This test
// runs the real SDK (no mock) and reads what leaves through the transport.

const TOKEN = 'canary-reset-token-5f1c'

const sentBodies: string[] = []

const decode = async (body: unknown): Promise<string> => {
    if (typeof body === 'string') return body
    if (body instanceof Uint8Array) return new TextDecoder().decode(body)
    if (body instanceof Blob) return body.text()
    return String(body)
}

describe('sentry tracing (real SDK)', () => {
    beforeEach(() => {
        vi.resetModules()
        sentBodies.length = 0
        vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.invalid/1')
        vi.stubEnv('VITE_SENTRY_ENABLED', 'true')
        vi.stubEnv('VITE_SENTRY_TRACES_SAMPLE_RATE', '1')
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
                sentBodies.push(await decode(init?.body))
                return new Response('{}', { status: 200 })
            }),
        )
    })

    afterEach(async () => {
        const Sentry = await import('@sentry/vue')
        await Sentry.close(0)
        vi.unstubAllEnvs()
        vi.unstubAllGlobals()
    })

    it('does not send a query token of a navigation in spans', async () => {
        const Sentry = await import('@sentry/vue')
        const { sentryService } = await import('@/utils/sentry-service')

        const Page = defineComponent({ render: () => null })
        const router = createRouter({
            history: createMemoryHistory(),
            routes: [
                { path: '/', name: 'Home', component: Page },
                { path: '/reset-password', name: 'ResetPassword', component: Page },
            ],
        })
        const app = createApp(Page)
        app.use(router)
        sentryService.init(app, router)
        expect(sentryService.isEnabled()).toBe(true)

        await router.push('/')
        await router.push(`/reset-password?token=${TOKEN}&lang=uk`)

        // Ends the idle navigation span and sends it.
        Sentry.getActiveSpan()?.end()
        await Sentry.flush(2000)

        const sent = sentBodies.join('\n')
        expect(sent).toContain('reset-password')
        expect(sent).not.toContain(TOKEN)
        expect(sent).toContain('[Filtered]')
    })

    it('does not send a query token of a failed navigation in the error event', async () => {
        vi.stubEnv('VITE_SENTRY_TRACES_SAMPLE_RATE', '0')
        const Sentry = await import('@sentry/vue')
        const { sentryService } = await import('@/utils/sentry-service')

        const Page = defineComponent({ render: () => null })
        const router = createRouter({
            history: createMemoryHistory(),
            routes: [
                { path: '/', component: Page },
                {
                    path: '/reset-password',
                    name: 'ResetPassword',
                    component: Page,
                    beforeEnter: () => {
                        throw new Error('guard failed')
                    },
                },
            ],
        })
        const app = createApp(Page)
        app.use(router)
        // Registered before init, as in main.ts: this handler's event is the one sent, the
        // SDK's own router.onError duplicate is dropped by Dedupe. It still passes the full
        // path (the old main.ts handler): beforeSend must clean it.
        router.onError((error, to) => {
            sentryService.captureException(error, { extra: { targetRoute: to.fullPath } })
        })
        sentryService.init(app, router)
        await router.push('/')
        await router.push(`/reset-password?token=${TOKEN}`).catch(() => undefined)
        await Sentry.flush(2000)

        const sent = sentBodies.join('\n')
        expect(sent).toContain('guard failed')
        expect(sent).toContain('targetRoute')
        expect(sent).not.toContain(TOKEN)
    })
})
