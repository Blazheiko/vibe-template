import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-233 (Р9): a request that renews the session (password change, "end all other sessions")
// replaces the session other requests of the page were sent from. Their 401 is stale: it must
// not sign the user out, whichever answer comes first. A read is sent once more from the renewed
// session; a change is not.

const emitMock = vi.hoisted(() => vi.fn())
const OLD = 'a'.repeat(43)
const NEW = 'b'.repeat(43)

vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi: vi.fn() }),
}))
vi.mock('../event-bus', () => ({ useEventBus: () => ({ emit: emitMock }) }))

const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })
const unauthorized = (): Response =>
    json({ status: 'error', code: 'unauthorized', message: 'Unauthorized' }, 401)
const renewed = (): Response =>
    json({ status: 'success', sessionRenewed: true, csrfToken: NEW, wsUrl: 'ws', wsToken: 't' })
const notRenewed = (): Response => json({ status: 'success', sessionRenewed: false })

interface Deferred {
    promise: Promise<Response>
    resolve: (response: Response) => void
}
const deferred = (): Deferred => {
    let resolve: (response: Response) => void = () => undefined
    const promise = new Promise<Response>((r) => {
        resolve = r
    })
    return { promise, resolve }
}

/** fetch double: each path answers from its own queue, in order. */
const createServer = (routes: Record<string, (Response | Deferred)[]>) => {
    const queues: Partial<Record<string, (Response | Deferred)[]>> = Object.fromEntries(
        Object.entries(routes).map(([path, list]) => [path, [...list]]),
    )
    const fetchMock = vi.fn((url: string): Promise<Response> => {
        const path = Object.keys(queues).find((key) => url.endsWith(key))
        const reply = path === undefined ? undefined : queues[path]?.shift()
        if (reply === undefined) return Promise.resolve(json({ status: 'success' }))
        return reply instanceof Response ? Promise.resolve(reply) : reply.promise
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
}

const loadApi = async () => {
    const csrf = await import('../csrf-token')
    csrf.confirmCsrfToken(OLD, '1')
    const module = await import('../base-api')
    module.setRefreshTimeout(50)
    module.setReloadHandler(vi.fn())
    module.setCurrentUserIdProvider(() => '1')
    return { api: module.default, csrf }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const RENEW = '/api/account/sessions/revoke-others'

describe('a stale 401 during a session renewal (feat-233, Р9)', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    it('renewal answers first, then the 401 of the old session: the user stays signed in', async () => {
        const stale = deferred()
        createServer({ [RENEW]: [renewed()], '/api/account/profile': [stale] })
        const { api, csrf } = await loadApi()

        const read = api.http('PATCH', '/api/account/profile', { name: 'x' })
        const renewal = await api.http('POST', RENEW, {}, { renewsSession: true })
        expect(renewal.error).toBeNull()
        expect(csrf.getCsrfToken()).toBe(NEW)
        stale.resolve(unauthorized())

        const result = await read
        expect(result.error?.clientCode).toBe('session_renewed')
        expect(emitMock).not.toHaveBeenCalledWith('unauthorized')
    })

    it('the 401 answers first: it waits for the renewal, then it is stale', async () => {
        const renewal = deferred()
        createServer({ [RENEW]: [renewal], '/api/account/profile': [unauthorized()] })
        const { api } = await loadApi()

        const renewing = api.http('POST', RENEW, {}, { renewsSession: true })
        await flush()
        const change = api.http('PATCH', '/api/account/profile', { name: 'x' })
        await flush()
        expect(emitMock).not.toHaveBeenCalledWith('unauthorized')
        renewal.resolve(renewed())
        await renewing

        expect((await change).error?.clientCode).toBe('session_renewed')
        expect(emitMock).not.toHaveBeenCalledWith('unauthorized')
    })

    it('the renewal fails (sessionRenewed: false): the waiting 401 signs the user out', async () => {
        const renewal = deferred()
        createServer({ [RENEW]: [renewal], '/api/account/profile': [unauthorized()] })
        const { api } = await loadApi()

        const renewing = api.http('POST', RENEW, {}, { renewsSession: true })
        await flush()
        const change = api.http('PATCH', '/api/account/profile', { name: 'x' })
        await flush()
        renewal.resolve(notRenewed())
        await renewing

        const result = await change
        expect(result.error?.clientCode).toBeUndefined()
        expect(emitMock).toHaveBeenCalledWith('unauthorized')
    })

    it.each([
        ['a network error', () => Promise.reject(new Error('offline'))],
        ['its own 401', () => Promise.resolve(unauthorized())],
    ])('the renewal fails with %s: the waiting 401 signs the user out', async (_, fail) => {
        let rejectRenewal: () => void = () => undefined
        const fetchMock = vi.fn((url: string) => {
            if (url.endsWith(RENEW)) {
                return new Promise<Response>((resolve, reject) => {
                    rejectRenewal = () => {
                        fail().then(resolve, reject)
                    }
                })
            }
            return Promise.resolve(unauthorized())
        })
        globalThis.fetch = fetchMock as unknown as typeof fetch
        const { api } = await loadApi()

        const renewing = api.http('POST', RENEW, {}, { renewsSession: true })
        await flush()
        const change = api.http('PATCH', '/api/account/profile', { name: 'x' })
        await flush()
        rejectRenewal()
        await renewing

        expect((await change).error?.clientCode).toBeUndefined()
        expect(emitMock).toHaveBeenCalledWith('unauthorized')
    })

    it('a 401 of a request sent from the renewed session is a real one', async () => {
        createServer({ [RENEW]: [renewed()], '/api/account/profile': [unauthorized()] })
        const { api } = await loadApi()
        await api.http('POST', RENEW, {}, { renewsSession: true })

        const result = await api.http('PATCH', '/api/account/profile', { name: 'x' })
        expect(result.error?.clientCode).toBeUndefined()
        expect(emitMock).toHaveBeenCalledWith('unauthorized')
    })

    it('a stale GET is sent once more from the renewed session, exactly once', async () => {
        const stale = deferred()
        const fetchMock = createServer({
            [RENEW]: [renewed()],
            '/api/account/sessions': [stale, unauthorized()],
        })
        const { api } = await loadApi()

        const read = api.http('GET', '/api/account/sessions')
        await api.http('POST', RENEW, {}, { renewsSession: true })
        stale.resolve(unauthorized())
        const result = await read

        const reads = fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/account/sessions'))
        expect(reads).toHaveLength(2)
        // The repeated read was refused too, by a session that is current: a real 401.
        expect(result.error?.clientCode).toBeUndefined()
        expect(emitMock).toHaveBeenCalledWith('unauthorized')
    })

    it('a stale GET answered on its repeat gives its data', async () => {
        const stale = deferred()
        createServer({
            [RENEW]: [renewed()],
            '/api/account/sessions': [stale, json({ status: 'success', others: [] })],
        })
        const { api } = await loadApi()

        const read = api.http('GET', '/api/account/sessions')
        await api.http('POST', RENEW, {}, { renewsSession: true })
        stale.resolve(unauthorized())

        const result = await read
        expect(result.error).toBeNull()
        expect(result.data).toEqual({ status: 'success', others: [] })
        expect(emitMock).not.toHaveBeenCalledWith('unauthorized')
    })

    it('a stale POST is not repeated', async () => {
        const stale = deferred()
        const fetchMock = createServer({ [RENEW]: [renewed()], '/api/account/sessions/x': [stale] })
        const { api } = await loadApi()

        const change = api.http('DELETE', '/api/account/sessions/x')
        await api.http('POST', RENEW, {}, { renewsSession: true })
        stale.resolve(unauthorized())

        expect((await change).error?.clientCode).toBe('session_renewed')
        expect(
            fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/account/sessions/x')),
        ).toHaveLength(1)
    })

    it('the same race with a password change', async () => {
        const stale = deferred()
        createServer({
            '/api/auth/change-password': [renewed()],
            '/api/account/profile': [stale],
        })
        const { api } = await loadApi()

        const change = api.http('PATCH', '/api/account/profile', { name: 'x' })
        await api.http(
            'POST',
            '/api/auth/change-password',
            { newPassword: 'p' },
            { renewsSession: true },
        )
        stale.resolve(unauthorized())

        expect((await change).error?.clientCode).toBe('session_renewed')
        expect(emitMock).not.toHaveBeenCalledWith('unauthorized')
    })
})
