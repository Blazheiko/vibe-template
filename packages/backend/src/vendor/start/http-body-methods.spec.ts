import { type } from '@arktype/type'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineRawRoute } from '#app/routing/define-raw-route.js'
import type { HttpContext } from '#vendor/types/types.js'

// Goes through the handler registered with uWS (server.patch / server.post),
// the real collectRequestMetadata and res.onData — so it fails if hasBody
// or the missing Content-Type branch regress, unlike readAndParseBody tests
// that pass `hasBody: true` themselves.

type Handler = (res: unknown, req: unknown) => unknown
const handlers = new Map<string, Handler>()
const fakeApp = {
    ws: vi.fn(),
    listen: vi.fn((_h: string, _p: number, cb: (token: unknown) => void) => {
        cb({})
    }),
    ...Object.fromEntries(
        ['get', 'post', 'put', 'patch', 'del', 'any'].map((method) => [
            method,
            vi.fn((path: string, handler: Handler) => {
                handlers.set(`${method} ${path}`, handler)
            }),
        ]),
    ),
}

vi.mock('uWebSockets.js', () => ({
    App: () => fakeApp,
    us_listen_socket_close: vi.fn(),
}))
vi.mock('#vendor/utils/network/get-ip.js', () => ({
    default: () => '127.0.0.1',
}))
vi.mock('#app/routes/http-routes.js', () => ({ default: [] }))
vi.mock('#app/routes/ws-routes.js', () => ({ default: [] }))
vi.mock('#vendor/utils/network/ws-handlers.js', () => ({
    onMessage: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    handleUpgrade: vi.fn(),
    closeAllWs: vi.fn(),
}))
vi.mock('#vendor/start/static-server.js', () => ({
    cacheStaticSource: vi.fn().mockResolvedValue(null),
    staticHandler: vi.fn(),
    staticCacheHandler: vi.fn(),
}))
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))

const received: unknown[] = []
const controller = vi.fn((context: HttpContext) => {
    received.push(context.httpData.payload)
    return { status: 'success' }
})

const RequiredSchema = type({ name: 'string' })
const OptionalSchema = type({ 'note?': 'string' })
const DefaultSchema = type({ tag: "string = 'none'" })

const route = (
    method: 'post' | 'patch',
    url: string,
    validator?: typeof RequiredSchema | typeof OptionalSchema | typeof DefaultSchema,
) => ({
    ...(validator === undefined
        ? defineRawRoute({ url, method, handler: controller })
        : defineRawRoute({ url, method, validator, handler: controller })),
    url: `api/${url}`,
    middlewares: [],
})

interface Sent {
    status: string
    body: unknown
}

const send = async (
    method: 'post' | 'patch',
    url: string,
    headers: Record<string, string>,
    body = '',
): Promise<Sent> => {
    let status = ''
    let responseBody = ''
    let done: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
        done = resolve
    })
    const res = {
        cork: (cb: () => void) => {
            cb()
            return res
        },
        onAborted: () => res,
        onData: (cb: (chunk: ArrayBuffer, isLast: boolean) => void) => {
            const bytes = new TextEncoder().encode(body)
            cb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true)
            return res
        },
        writeStatus: (s: string) => {
            status = s
            return res
        },
        writeHeader: () => res,
        end: (chunk?: string) => {
            responseBody = chunk ?? ''
            done()
            return res
        },
        close: () => {
            done()
            return res
        },
    }
    const req = {
        getUrl: () => `/api/${url}`,
        getMethod: () => method,
        getQuery: () => '',
        getParameter: () => '',
        getHeader: (name: string) => headers[name] ?? '',
        forEach: (cb: (k: string, v: string) => void) => {
            Object.entries(headers).forEach(([k, v]) => {
                cb(k, v)
            })
        },
    }
    const handler = handlers.get(`${method} /api/${url}`)
    if (handler === undefined) throw new Error(`no handler for ${method} ${url}`)
    await handler(res, req)
    await finished
    return {
        status,
        body: responseBody === '' ? null : (JSON.parse(responseBody) as unknown),
    }
}

const json = (body: string): Record<string, string> => ({
    'content-type': 'application/json',
    'content-length': String(body.length),
})

describe('HTTP methods with a request body', () => {
    beforeAll(async () => {
        const { initServer } = await import('./server.js')
        await initServer({
            httpRoutes: [
                route('patch', 'items', RequiredSchema),
                route('post', 'required', RequiredSchema),
                route('post', 'optional', OptionalSchema),
                route('post', 'defaults', DefaultSchema),
                route('post', 'no-validator'),
            ].map((route) => ({ ...route, responseCheck: null })),
            wsRoutesByUrl: new Map(),
            sourceHttpRoutes: [],
            sourceWsRoutes: [],
        } as never)
    })

    beforeEach(() => {
        controller.mockClear()
        received.length = 0
    })

    describe('PATCH', () => {
        it('reads and validates the body', async () => {
            const body = JSON.stringify({ name: 'box' })
            const res = await send('patch', 'items', json(body), body)

            expect(res.status).toBe('200 OK')
            expect(received).toEqual([{ name: 'box' }])
        })

        it('rejects an invalid body with 422 without calling the handler', async () => {
            const body = JSON.stringify({ name: 42 })
            const res = await send('patch', 'items', json(body), body)

            expect(res.status).toBe('422 Unprocessable Entity')
            expect(controller).not.toHaveBeenCalled()
        })
    })

    describe('route with a validator, no Content-Type', () => {
        it('validates an absent body as {}: required fields → 422, handler not called', async () => {
            const res = await send('post', 'required', {})

            expect(res.status).toBe('422 Unprocessable Entity')
            expect(controller).not.toHaveBeenCalled()
        })

        it('passes {} to the handler when the schema has no required fields', async () => {
            const res = await send('post', 'optional', { 'content-length': '0' })

            expect(res.status).toBe('200 OK')
            expect(received).toEqual([{}])
        })

        it('applies schema defaults to the empty body', async () => {
            const res = await send('post', 'defaults', {})

            expect(res.status).toBe('200 OK')
            expect(received).toEqual([{ tag: 'none' }])
        })

        it('rejects a body with Content-Length > 0 with 415 and receivedContentType null', async () => {
            const body = JSON.stringify({ name: 'box' })
            const res = await send(
                'post',
                'required',
                { 'content-length': String(body.length) },
                body,
            )

            expect(res.status).toBe('415 Unsupported Media Type')
            expect(res.body).toMatchObject({
                code: 'unsupported_media_type',
                details: { kind: 'unsupported_media_type', receivedContentType: null },
            })
            expect(controller).not.toHaveBeenCalled()
        })

        it.each(['0', '00', ' 000 '])(
            'treats Content-Length %j as no body and validates {}',
            async (contentLength) => {
                const res = await send('post', 'optional', { 'content-length': contentLength })

                expect(res.status).toBe('200 OK')
                expect(received).toEqual([{}])
            },
        )

        it('rejects chunked framing with 415 even when no bytes follow (policy)', async () => {
            const res = await send('post', 'optional', {
                'transfer-encoding': 'chunked',
            })

            expect(res.status).toBe('415 Unsupported Media Type')
            expect(controller).not.toHaveBeenCalled()
        })
    })

    it('keeps payload = null for a route without a validator and no Content-Type', async () => {
        const res = await send('post', 'no-validator', {})

        expect(res.status).toBe('200 OK')
        expect(received).toEqual([null])
    })
})
