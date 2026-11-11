import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-158 (review 2026-11-10, M7): the playground is where a developer reads why a request was
// refused. The client parsed the body of a 422 only: every other error showed a bare
// "HTTP error! status: 403", and an answer without a body was reported as a network error.

const emit = vi.hoisted(() => vi.fn())
vi.mock('@/utils/event-bus', () => ({ useEventBus: () => ({ emit, on: vi.fn(), off: vi.fn() }) }))
vi.mock('@/stores/api-settings', () => ({
    useApiSettingsStore: () => ({ settings: { baseUrl: 'http://api.test', globalHeaders: {} } }),
}))
const websocketApi = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi }),
}))

const { default: api } = await import('../base-api')

const answer = (status: number, body: unknown, contentType = 'application/json'): void => {
    const text = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body)
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve(
                new Response(text, {
                    status,
                    headers: text === null ? {} : { 'content-type': contentType },
                }),
            ),
        ),
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('playground http: an answer that is an error', () => {
    it('shows the body of a 403, so the CSRF reason can be read', async () => {
        const body = {
            status: 'error',
            code: 'csrf_invalid',
            message: 'CSRF validation failed',
            reason: 'origin_mismatch',
        }
        answer(403, body)

        const result = await api.http('POST', '/api/auth/logout')

        expect(result.status).toBe(403)
        expect(result.data).toEqual(body)
        expect(result.error).toEqual({ code: 403, message: 'CSRF validation failed' })
    })

    it.each([400, 404, 409, 413, 429, 500, 503])('shows the body of a %i', async (status) => {
        answer(status, { status: 'error', code: 'some_code', message: 'Why it failed' })

        const result = await api.http('GET', '/api/x')

        expect(result.data).toMatchObject({ code: 'some_code' })
        expect(result.error).toEqual({ code: status, message: 'Why it failed' })
    })

    it('still announces a 401, and shows its body too', async () => {
        answer(401, { status: 'error', code: 'session_revoked', message: 'Session revoked' })

        const result = await api.http('GET', '/api/main/init')

        expect(emit).toHaveBeenCalledWith('unauthorized')
        expect(result.data).toMatchObject({ code: 'session_revoked' })
        expect(result.error).toEqual({ code: 401, message: 'Session revoked' })
    })

    it('keeps the 422 answer as it was', async () => {
        const body = { status: 'error', code: 'validation_failed', message: 'Validation failure' }
        answer(422, body)

        const result = await api.http('POST', '/api/x', {})

        expect(result.data).toEqual(body)
        expect(result.error).toEqual({ code: 422, message: 'Validation failure' })
    })

    it('says only the status for an error without a JSON body', async () => {
        answer(502, '<html>Bad gateway</html>', 'text/html')

        const result = await api.http('GET', '/api/x')

        expect(result.status).toBe(502)
        expect(result.data).toBeNull()
        expect(result.error).toEqual({ code: 502, message: 'HTTP error! status: 502' })
    })
})

describe('playground http: an answer without a body', () => {
    it('is a success for a 204, not a network error', async () => {
        answer(204, null)

        const result = await api.http('DELETE', '/api/x')

        expect(result.status).toBe(204)
        expect(result.error).toBeNull()
        expect(result.data).toBeNull()
    })

    it('is a success for a 200 that is not JSON', async () => {
        answer(200, 'pong', 'text/plain')

        const result = await api.http('GET', '/api/ping')

        expect(result.status).toBe(200)
        expect(result.error).toBeNull()
        expect(result.data).toBeNull()
    })

    it('is still the JSON of a 200', async () => {
        answer(200, { status: 'ok', value: 7 })

        const result = await api.http('GET', '/api/x')

        expect(result.data).toEqual({ status: 'ok', value: 7 })
        expect(result.error).toBeNull()
    })
})

describe('playground ws', () => {
    it('hands the reply over', async () => {
        const reply = { event: 'api/x', status: '200', data: { ok: true } }
        websocketApi.mockResolvedValue(reply)

        expect(await api.ws('/api/x', {})).toEqual(reply)
    })

    it('does not turn a refused or lost request into a result: the caller gets the error', async () => {
        const failure = Object.assign(new Error('Validation failure'), { status: 'error' })
        websocketApi.mockRejectedValue(failure)

        await expect(api.ws('/api/x', {})).rejects.toBe(failure)
    })
})

// feat-165 (review 2026-11-10): the request was logged with its body, so the password of
// auth/login and every token sent stayed in the console.
describe('playground http: what goes to the console', () => {
    it('does not log the body of a request', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
        answer(200, { status: 'success', wsToken: 'ws-secret-token' })

        await api.http('POST', '/api/auth/login', {
            identifier: 'jane@example.com',
            password: 'correct-horse-battery',
        })

        const logged = JSON.stringify(log.mock.calls)
        expect(logged).toContain('/api/auth/login')
        expect(logged).not.toContain('correct-horse-battery')
        expect(logged).not.toContain('ws-secret-token')
    })
})

describe('playground checkServerHealth', () => {
    it("asks the dev server's own origin when the base URL is empty (the proxy)", async () => {
        answer(200, 'pong', 'text/plain')
        const { checkServerHealth } = await import('../base-api')

        expect(await checkServerHealth('')).toBe(true)
        expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/ping')
    })
})
