import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    adminContracts,
    authContracts,
    avatarContracts,
    knowledgeBaseContracts,
    oauthContracts,
    pushSubscriptionContracts,
    supportContracts,
} from 'shared/contracts'

// The typed client (docs/adr/0005-route-contracts.md) over the REAL transport: the fetch double
// is the only fake. The transport's own tests (base-api-csrf.spec.ts) would stay green if this
// wrapper dropped an option on the way, so what the transport does is checked here again,
// through `callApi`.

const emitMock = vi.hoisted(() => vi.fn())
const TOKEN_U1 = 'a'.repeat(43)
const TOKEN_U2 = 'b'.repeat(43)
const TOKEN_ANON = 'c'.repeat(43)
const TOKEN_U1_FRESH = 'd'.repeat(43)
const INIT = '/api/main/init'

vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi: vi.fn() }),
}))
vi.mock('../event-bus', () => ({ useEventBus: () => ({ emit: emitMock }) }))

const jsonResponse = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })

const tokenMismatch = (csrfToken?: string): Response =>
    jsonResponse(
        {
            status: 'error',
            code: 'csrf_invalid',
            message: 'Invalid CSRF token',
            reason: 'token_mismatch',
            ...(csrfToken === undefined ? {} : { csrfToken }),
        },
        403,
    )

const initAs = (userId: string, csrfToken: string): Response =>
    jsonResponse({ status: 'ok', user: { id: userId }, csrfToken })

const initAnonymous = (csrfToken: string): Response =>
    jsonResponse({ status: 'error', code: 'unauthorized', message: 'No session', csrfToken }, 401)

type Reply = Response | ((init?: RequestInit) => Promise<Response>)

const createServer = (replies: { init?: Reply[]; other?: Reply[] }) => {
    const initReplies = [...(replies.init ?? [])]
    const other = [...(replies.other ?? [])]
    const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        const queue = url.endsWith(INIT) ? initReplies : other
        // As fetch does: an aborted signal rejects, whatever the server would have said.
        if (init?.signal?.aborted === true) {
            return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
        }
        const reply = queue.shift() ?? jsonResponse({ status: 'success' })
        return typeof reply === 'function' ? reply(init) : Promise.resolve(reply)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
}

type Server = ReturnType<typeof createServer>

const requests = (server: Server) =>
    server.mock.calls
        .filter(([url]) => !url.endsWith(INIT))
        .map(([url, init]) => ({
            // Path and query: the transport puts its base URL in front.
            url: url.replace(/^https?:\/\/[^/]+/, ''),
            method: init?.method,
            body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
            token: (init?.headers as Record<string, string> | undefined)?.['X-CSRF-Token'],
            signal: init?.signal,
        }))

interface Setup {
    token?: string
    tokenUser?: string | null
    uiUser?: string | null
}

const load = async ({ token = TOKEN_U1, tokenUser = '1', uiUser = '1' }: Setup = {}) => {
    const csrf = await import('../csrf-token')
    if (token !== '') csrf.confirmCsrfToken(token, tokenUser)
    const transport = await import('../base-api')
    transport.setRefreshTimeout(50)
    const reload = vi.fn()
    transport.setReloadHandler(reload)
    transport.setCurrentUserIdProvider(() => uiUser)
    const { callApi, contractUrl } = await import('../api-client')
    return { callApi, contractUrl, csrf, reload }
}

const SUBSCRIPTION = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/x',
    p256dhKey: 'p',
    authKey: 'a',
}

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    createServer({})
})

describe('callApi: the request it makes', () => {
    it('sends the method, the path under the API prefix and the body of the contract', async () => {
        const server = createServer({})
        const { callApi } = await load()

        await callApi(pushSubscriptionContracts.create, { body: SUBSCRIPTION })

        expect(requests(server)).toEqual([
            expect.objectContaining({
                url: '/api/push-subscriptions',
                method: 'POST',
                body: SUBSCRIPTION,
                token: TOKEN_U1,
            }),
        ])
    })

    it('puts the path parameters into the path, encoded', async () => {
        const server = createServer({})
        const { callApi } = await load()

        await callApi(pushSubscriptionContracts.remove, { params: { subscriptionId: '7/..?x' } })

        expect(requests(server)[0]).toMatchObject({
            url: '/api/push-subscriptions/7%2F..%3Fx',
            method: 'DELETE',
        })
        expect(requests(server)[0]?.body).toBeUndefined()
    })

    it('serialises the query, leaving out what is empty', async () => {
        const server = createServer({})
        const { callApi } = await load()

        await callApi(adminContracts.users, {
            query: { limit: 100, cursor: '2', userId: '', dateFrom: '2026-11-01' },
        })

        expect(requests(server)[0]).toMatchObject({
            url: '/api/admin/users?limit=100&cursor=2&dateFrom=2026-11-01',
            method: 'GET',
        })
    })

    it('needs no input for a contract without parameters, query and body', async () => {
        const server = createServer({})
        const { callApi } = await load()

        await callApi(pushSubscriptionContracts.list)

        expect(requests(server)[0]).toMatchObject({ url: '/api/push-subscriptions', method: 'GET' })
    })

    it('hands back the answer typed as the contract says', async () => {
        createServer({ other: [jsonResponse({ status: 'success', vapidPublicKey: 'key-1' })] })
        const { callApi } = await load()

        const result = await callApi(pushSubscriptionContracts.vapidPublicKey)

        expect(result.error).toBeNull()
        // Narrowed by the response type of the contract, not by a cast.
        const key = result.data?.status === 'success' ? result.data.vapidPublicKey : undefined
        expect(key).toBe('key-1')
    })
})

describe('callApi: the options reach the transport', () => {
    it('signal: a call with an aborted signal ends without an answer', async () => {
        createServer({ other: [jsonResponse({ status: 'success' })] })
        const { callApi } = await load()
        const controller = new AbortController()
        controller.abort()

        const result = await callApi(
            pushSubscriptionContracts.create,
            { body: SUBSCRIPTION },
            { signal: controller.signal },
        )

        expect(result.data).toBeNull()
        expect(result.error).toMatchObject({ transportCode: 0 })
    })

    it('signal: the same signal is the one fetch gets, and aborting it ends the call', async () => {
        const controller = new AbortController()
        const server = createServer({
            other: [
                (init) =>
                    new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener('abort', () => {
                            reject(new DOMException('The operation was aborted.', 'AbortError'))
                        })
                    }),
            ],
        })
        const { callApi } = await load()

        const pending = callApi(
            pushSubscriptionContracts.create,
            { body: SUBSCRIPTION },
            { signal: controller.signal },
        )
        await vi.waitFor(() => {
            expect(requests(server)).toHaveLength(1)
        })
        expect(requests(server)[0]?.signal).toBe(controller.signal)
        controller.abort()

        expect((await pending).data).toBeNull()
        expect((await pending).error).not.toBeNull()
    })

    it('csrfRecovery "public": a login is repeated once while the session is still anonymous', async () => {
        const server = createServer({
            init: [initAnonymous(TOKEN_ANON)],
            other: [
                tokenMismatch(TOKEN_ANON),
                jsonResponse({ status: 'success', user: { id: '1' } }),
            ],
        })
        const { callApi } = await load({ token: TOKEN_U2, tokenUser: null, uiUser: null })

        const result = await callApi(
            authContracts.login,
            { body: { identifier: 'a@example.test', password: 'secret-123456' } },
            { csrfRecovery: 'public' },
        )

        expect(result.error).toBeNull()
        const sent = requests(server)
        expect(sent).toHaveLength(2)
        expect(sent[1]?.token).toBe(TOKEN_ANON)
        expect(emitMock).not.toHaveBeenCalledWith('unauthorized')
    })

    it('csrfRecovery default "protected": after a 401 from init nothing is repeated', async () => {
        const server = createServer({
            init: [initAnonymous(TOKEN_ANON)],
            other: [tokenMismatch(TOKEN_ANON)],
        })
        const { callApi } = await load()

        const result = await callApi(pushSubscriptionContracts.create, { body: SUBSCRIPTION })

        expect(requests(server)).toHaveLength(1)
        expect(result.error).not.toBeNull()
    })

    it('a token mismatch is repeated at most once, with the token of the refreshed session', async () => {
        const server = createServer({
            init: [initAs('1', TOKEN_U1_FRESH)],
            other: [tokenMismatch(TOKEN_U1_FRESH), tokenMismatch()],
        })
        const { callApi } = await load()

        const result = await callApi(pushSubscriptionContracts.create, { body: SUBSCRIPTION })

        const sent = requests(server)
        expect(sent).toHaveLength(2)
        expect(sent.map((request) => request.token)).toEqual([TOKEN_U1, TOKEN_U1_FRESH])
        expect(result.error).toMatchObject({ code: 'csrf_invalid', transportCode: 403 })
    })

    it('account changed: the session is another user’s now — not repeated, the page reloads', async () => {
        const server = createServer({
            init: [initAs('2', TOKEN_U2)],
            other: [tokenMismatch(TOKEN_U2)],
        })
        const { callApi, csrf, reload } = await load()

        const result = await callApi(pushSubscriptionContracts.create, { body: SUBSCRIPTION })

        expect(requests(server)).toHaveLength(1)
        expect(reload).toHaveBeenCalledOnce()
        expect(csrf.getSessionState()).toBe('reloading')
        expect(result.error).toMatchObject({ clientCode: 'account_changed' })
    })

    it('sessionAfter "anonymous": the token of the answer is the anonymous session’s', async () => {
        createServer({ other: [jsonResponse({ status: 'success', csrfToken: TOKEN_ANON })] })
        const { callApi, csrf } = await load()

        // Any contract will do: the option belongs to the transport, not to the route.
        await callApi(
            pushSubscriptionContracts.testPush,
            { body: {} },
            { sessionAfter: 'anonymous' },
        )

        expect(csrf.getCsrfToken()).toBe(TOKEN_ANON)
        expect(csrf.getConfirmedUserId()).toBeNull()
    })
})

// feat-177: a multipart contract goes through the same transport as a JSON one (the CSRF token,
// the session gate), with a FormData body the browser frames itself.
describe('callApi: a multipart contract', () => {
    it('sends the files and the fields as FormData, with the CSRF token', async () => {
        const server = createServer({})
        const { callApi } = await load()
        const avatar = new Blob(['x'], { type: 'image/webp' })

        await callApi(avatarContracts.upload, {
            body: { fields: {}, files: { avatar: { blob: avatar, filename: 'avatar.webp' } } },
        })

        const [request] = requests(server)
        expect(request).toMatchObject({
            url: '/api/avatar/upload',
            method: 'POST',
            token: TOKEN_U1,
        })
        expect(request.body).toBeInstanceOf(FormData)
        const file = (request.body as FormData).get('avatar')
        expect(file).toBeInstanceOf(File)
        expect((file as File).name).toBe('avatar.webp')
        // No JSON Content-Type: the browser sets the multipart boundary itself.
        const headers = server.mock.lastCall?.[1]?.headers as Record<string, string>
        expect(headers['Content-Type']).toBeUndefined()
    })

    it('puts the path parameters of a multipart contract into the path', async () => {
        const server = createServer({})
        const { callApi } = await load()

        await callApi(knowledgeBaseContracts.uploadScreenshot, {
            params: { id: '7' },
            body: { fields: {}, files: { screenshot: new Blob(['x']) } },
        })

        expect(requests(server)[0]?.url).toBe('/api/admin/knowledge-base/7/screenshot')
    })

    it('is repeated once after a token mismatch, with the same files', async () => {
        const server = createServer({
            init: [initAs('1', TOKEN_U1_FRESH)],
            other: [tokenMismatch(), jsonResponse({ status: 'ok' })],
        })
        const { callApi } = await load()

        const result = await callApi(avatarContracts.upload, {
            body: { fields: {}, files: { avatar: new Blob(['x']) } },
        })

        expect(result.error).toBeNull()
        const sent = requests(server)
        expect(sent.map((request) => request.token)).toEqual([TOKEN_U1, TOKEN_U1_FRESH])
        expect((sent[1]?.body as FormData).get('avatar')).toBeInstanceOf(File)
    })
})

describe('contractUrl', () => {
    it('builds the URL of a navigation contract under the API prefix, encoded', async () => {
        const { contractUrl } = await load()

        expect(contractUrl(oauthContracts.redirect, { params: { provider: 'google' } })).toBe(
            '/api/auth/oauth/google/redirect',
        )
        expect(contractUrl(supportContracts.screenshot, { params: { articleId: 'a/b' } })).toBe(
            '/api/support/screenshot/a%2Fb',
        )
    })
})

// Checked by the type checker (`vue-tsc --build` compiles the specs): a call that does not fit
// the contract does not compile. Nothing here runs.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function typeChecks(): Promise<void> {
    const { callApi, contractUrl } = await import('../api-client')

    // @ts-expect-error — a navigation contract is never fetched
    await callApi(supportContracts.screenshot, { params: { articleId: '1' } })
    // @ts-expect-error — contractUrl is for navigation contracts only
    contractUrl(pushSubscriptionContracts.list)
    // @ts-expect-error — the path parameter of a navigation contract is required
    contractUrl(oauthContracts.redirect)
    await callApi(avatarContracts.upload, {
        // @ts-expect-error — the file goes under the contract's field name
        body: { fields: {}, files: { picture: new Blob(['x']) } },
    })
    await callApi(avatarContracts.upload, {
        // @ts-expect-error — a multipart body is fields and files, not a JSON object
        body: { avatar: new Blob(['x']) },
    })

    // @ts-expect-error — the body is required
    await callApi(pushSubscriptionContracts.create)
    await callApi(pushSubscriptionContracts.create, {
        // @ts-expect-error — a field the schema does not have
        body: { ...SUBSCRIPTION, ipAddress: '1.2.3.4' },
    })
    // @ts-expect-error — a field of the wrong type
    await callApi(pushSubscriptionContracts.create, { body: { ...SUBSCRIPTION, endpoint: 7 } })
    // @ts-expect-error — the path parameter is required
    await callApi(pushSubscriptionContracts.remove)
    // @ts-expect-error — the path parameter has another name
    await callApi(pushSubscriptionContracts.remove, { params: { id: '7' } })
    // @ts-expect-error — a route without a body takes none
    await callApi(pushSubscriptionContracts.list, { body: {} })
    // @ts-expect-error — a query key the contract does not have
    await callApi(adminContracts.users, { query: { page: 2 } })
    // @ts-expect-error — the method is the contract's, there is nothing to pass
    await callApi(pushSubscriptionContracts.list, undefined, { method: 'POST' })

    const answer = await callApi(authContracts.login, {
        body: { identifier: 'a@example.test', password: 'secret-123456' },
    })
    // @ts-expect-error — the answer is the login response, which has no `items`
    console.log(answer.data?.items)
}
