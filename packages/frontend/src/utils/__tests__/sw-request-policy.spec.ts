import { describe, expect, it } from 'vitest'

import {
    classifyRequest,
    isApiPath,
    isCacheableResponse,
    removeCachedApiResponses,
    type RequestDescription,
} from '../sw-request-policy'

const ORIGIN = 'https://app.test'

const describeRequest = (
    path: string,
    overrides: Partial<RequestDescription> = {},
): RequestDescription => ({
    url: path.startsWith('http') ? path : `${ORIGIN}${path}`,
    method: 'GET',
    destination: '',
    mode: 'cors',
    swOrigin: ORIGIN,
    apiPrefix: 'api',
    ...overrides,
})

describe('classifyRequest', () => {
    it.each([
        ['API GET', describeRequest('/api/main/init')],
        ['API POST', describeRequest('/api/auth/login', { method: 'POST' })],
        ['API root', describeRequest('/api')],
        ['API path that looks static', describeRequest('/api/admin/icons/x.png')],
        ['API path with .css', describeRequest('/api/files/theme.css')],
        ['POST to a static path', describeRequest('/icons/x.png', { method: 'POST' })],
        ['DELETE to an asset', describeRequest('/assets/a.js', { method: 'DELETE' })],
        ['cross-origin asset', describeRequest('https://cdn.test/assets/a.js')],
        ['cross-origin navigation', describeRequest('https://other.test/', { mode: 'navigate' })],
        ['non-http scheme', describeRequest('chrome-extension://x/y.js')],
        ['script outside /assets/', describeRequest('/sw-helper.js', { destination: 'script' })],
    ])('bypasses %s', (_, request) => {
        expect(classifyRequest(request)).toBe('bypass')
    })

    it.each([
        ['/assets/index-abc.js'],
        ['/icons/icon_192x192.png'],
        ['/screenshots/editor-mobile.png'],
        ['/manifest.json'],
        ['/favicon.svg'],
        ['/styles/theme.css'],
    ])('serves %s cache-first', (path) => {
        expect(classifyRequest(describeRequest(path))).toBe('cache-first')
    })

    it('serves navigations network-first', () => {
        expect(classifyRequest(describeRequest('/account', { mode: 'navigate' }))).toBe(
            'network-first',
        )
        expect(classifyRequest(describeRequest('/', { destination: 'document' }))).toBe(
            'network-first',
        )
    })

    it('does not take /api-docs for the API under the default prefix', () => {
        expect(isApiPath('/api-docs/x', 'api')).toBe(false)
        expect(classifyRequest(describeRequest('/api-docs/x'))).toBe('stale-while-revalidate')
    })

    it('follows a non-default API prefix', () => {
        const prefix = { apiPrefix: 'v2/backend' }
        expect(classifyRequest(describeRequest('/v2/backend/main/init', prefix))).toBe('bypass')
        expect(classifyRequest(describeRequest('/v2/backend/icons/x.png', prefix))).toBe('bypass')
        expect(classifyRequest(describeRequest('/v2/backendish/x', prefix))).toBe(
            'stale-while-revalidate',
        )
        // Under another prefix /api/... is an ordinary path.
        expect(classifyRequest(describeRequest('/api/theme.css', prefix))).toBe('cache-first')
    })
})

describe('isCacheableResponse', () => {
    const response = (overrides: { ok?: boolean; type?: ResponseType; cacheControl?: string }) =>
        ({
            ok: overrides.ok ?? true,
            type: overrides.type ?? 'basic',
            headers: new Headers(
                overrides.cacheControl === undefined
                    ? {}
                    : { 'Cache-Control': overrides.cacheControl },
            ),
        }) as Response

    it('stores a complete same-origin response', () => {
        expect(isCacheableResponse(response({}))).toBe(true)
        expect(isCacheableResponse(response({ cacheControl: 'public, max-age=0' }))).toBe(true)
    })

    it.each([
        ['no-store', response({ cacheControl: 'no-store' })],
        ['private', response({ cacheControl: 'private, max-age=60' })],
        ['opaque', response({ type: 'opaque' })],
        ['cors', response({ type: 'cors' })],
        ['500', response({ ok: false })],
    ])('refuses %s', (_, value) => {
        expect(isCacheableResponse(value)).toBe(false)
    })
})

describe('removeCachedApiResponses', () => {
    const fakeStorage = (urls: string[]) => {
        const entries = new Map(urls.map((url) => [url, new Request(url)]))
        const cache = {
            keys: () => Promise.resolve([...entries.values()]),
            delete: (request: Request) => Promise.resolve(entries.delete(request.url)),
        }
        const opened: string[] = []
        const storage = {
            open: (name: string) => {
                opened.push(name)
                return Promise.resolve(cache)
            },
        } as unknown as CacheStorage
        return { storage, entries, opened }
    }

    it('removes only API entries of the build cache', async () => {
        const { storage, entries, opened } = fakeStorage([
            `${ORIGIN}/api/main/init`,
            `${ORIGIN}/api/admin/icons/x.png`,
            `${ORIGIN}/`,
            `${ORIGIN}/favicon.svg`,
            `${ORIGIN}/api-docs/x`,
        ])

        const removed = await removeCachedApiResponses(storage, 'build-1', 'api')

        expect(removed).toBe(2)
        expect(opened).toEqual(['build-1'])
        expect([...entries.keys()]).toEqual([
            `${ORIGIN}/`,
            `${ORIGIN}/favicon.svg`,
            `${ORIGIN}/api-docs/x`,
        ])
    })

    it('follows a non-default prefix', async () => {
        const { storage, entries } = fakeStorage([
            `${ORIGIN}/v2/backend/main/init`,
            `${ORIGIN}/api/main/init`,
        ])

        await removeCachedApiResponses(storage, 'build-1', 'v2/backend')

        expect([...entries.keys()]).toEqual([`${ORIGIN}/api/main/init`])
    })
})
