import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-181: a route declared through a contract (ADR 0005, 0006) is serialized with the whole
// path of its contract as `url` and in `contractPath`, not with a path relative to its group.
// The playground put the group prefix in front of it once more, so its forms sent requests of
// those routes to `/api/admin/admin/users` and the WS event `api/support/support/…`.

vi.mock('@/stores/api-settings', () => ({
    useApiSettingsStore: () => ({ settings: { baseUrl: 'http://api.test', globalHeaders: {} } }),
}))

const doc = {
    pathPrefix: 'api',
    httpRoutes: [
        {
            prefix: 'admin',
            group: [
                {
                    method: 'get',
                    url: '/admin/users',
                    contractPath: '/admin/users',
                    handler: null,
                },
                { method: 'get', url: '/raw', handler: null },
            ],
        },
    ],
    wsRoutes: [
        {
            prefix: 'support',
            group: [
                {
                    method: 'ws',
                    url: '/support/support_chat',
                    contractPath: '/support/support_chat',
                    handler: null,
                },
            ],
        },
    ],
}

beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(JSON.stringify(doc), { status: 200 }))),
    )
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('the full URL of a route in the playground', () => {
    it('is the prefix and the contract path for a route with a contract', async () => {
        const { useApiStore } = await import('../api-doc')
        const store = useApiStore()

        await store.fetchRoutes()

        expect(store.flatHttpRoute.map((route) => route.fullUrl)).toEqual([
            'api/admin/users',
            'api/admin/raw',
        ])
        expect(store.flatWsRoute.map((route) => route.fullUrl)).toEqual([
            'api/support/support_chat',
        ])
    })
})
