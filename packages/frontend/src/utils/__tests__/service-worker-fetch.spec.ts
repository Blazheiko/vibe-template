import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRECACHE_FILES } from '../sw-precache'

// feat-162 (review 2026-11-10): the service worker stored the HTML shell under the full URL
// of the navigation, query included, so `/reset-password?token=…` left the token in Cache
// Storage for as long as the build lived.

interface FakeFetchEvent {
    request: { url: string; method: string; destination: string; mode: string }
    respondWith: (response: Promise<Response>) => void
}

const htmlResponse = (): Response => {
    const response = {
        ok: true,
        type: 'basic',
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/html' }),
        clone: () => response,
    }
    return response as unknown as Response
}

const keyOf = (request: unknown): string =>
    typeof request === 'string' ? request : (request as { url: string }).url

const loadFetchHandler = async (stored: Map<string, Response>) => {
    const cache = {
        put: vi.fn((request: unknown, response: Response) => {
            stored.set(keyOf(request), response)
            return Promise.resolve()
        }),
    }
    vi.stubGlobal('caches', {
        open: vi.fn(() => Promise.resolve(cache)),
        match: vi.fn((request: unknown) => Promise.resolve(stored.get(keyOf(request)))),
    })
    // One open page: a reported error is posted to it and not queued in Cache Storage.
    vi.stubGlobal('clients', {
        matchAll: () => Promise.resolve([{ postMessage: vi.fn() }]),
    })
    const listeners = new Map<string, (event: never) => void>()
    vi.spyOn(globalThis, 'addEventListener').mockImplementation(((
        name: string,
        listener: (event: never) => void,
    ) => {
        listeners.set(name, listener)
    }) as typeof globalThis.addEventListener)

    await import('@/service-worker')
    const handler = listeners.get('fetch')
    if (handler === undefined) throw new Error('the service worker registered no fetch handler')
    return handler as unknown as (event: FakeFetchEvent) => void
}

const navigate = async (
    handler: (event: FakeFetchEvent) => void,
    path: string,
): Promise<Response> => {
    const answers: Promise<Response>[] = []
    handler({
        request: {
            url: `${location.origin}${path}`,
            method: 'GET',
            destination: 'document',
            mode: 'navigate',
        },
        respondWith: (response) => {
            answers.push(response)
        },
    })
    if (answers.length === 0) throw new Error('the navigation was not answered')
    const response = await answers[0]
    await new Promise((resolve) => setTimeout(resolve, 0))
    return response
}

describe('service worker: the HTML shell in the cache', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    it('stores a navigation without its query string', async () => {
        const stored = new Map<string, Response>()
        const handler = await loadFetchHandler(stored)
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(htmlResponse())),
        )

        await navigate(handler, '/reset-password?token=secret-token')

        expect([...stored.keys()]).toEqual([`${location.origin}/reset-password`])
        expect([...stored.keys()].join(' ')).not.toContain('token')
    })

    it('answers an offline navigation with the copy stored for the path', async () => {
        const stored = new Map<string, Response>()
        const handler = await loadFetchHandler(stored)
        const fetchMock = vi.fn(() => Promise.resolve(htmlResponse()))
        vi.stubGlobal('fetch', fetchMock)
        const online = await navigate(handler, '/reset-password?token=first')

        fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
        const offline = await navigate(handler, '/reset-password?token=second')

        expect(offline).toBe(online)
    })
})

// A path of the list that is not in public/ is a 404 on every install.
describe('service worker: the precache list', () => {
    const publicFiles = new Set(
        Object.keys(import.meta.glob('../../../public/**/*')).map((path) =>
            path.replace('../../../public', ''),
        ),
    )

    it('names only files that exist in public/', () => {
        const missing = PRECACHE_FILES.filter((path) => path !== '/' && !publicFiles.has(path))

        expect(publicFiles.size).toBeGreaterThan(0)
        expect(missing).toEqual([])
    })
})
