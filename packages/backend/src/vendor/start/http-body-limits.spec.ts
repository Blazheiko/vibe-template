import { type } from '@arktype/type'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineRawRoute } from '#app/routing/define-raw-route.js'
import type { HttpContext } from '#vendor/types/types.js'

// Goes through the handler registered with uWS (server.post), the real
// collectRequestMetadata, readAndParseBody and readData, with small limits so
// bodies can be built byte by byte. Sizes are bytes (Buffer.byteLength).

const LIMITS = { json: 64, other: 32, multipart: 256, octet: 512 }

vi.mock('#config/app.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return {
        default: {
            ...actual.default,
            maxBodySize: LIMITS.other,
            maxJsonBodySize: LIMITS.json,
            maxMultipartBodySize: LIMITS.multipart,
            maxOctetStreamBodySize: LIMITS.octet,
        },
    }
})

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
    getParts: () => [],
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

const route = (url: string, extra: Partial<Parameters<typeof defineRawRoute>[0]> = {}) => ({
    ...defineRawRoute({ url, method: 'post', handler: controller, ...extra } as never),
    url: `api/${url}`,
    middlewares: [],
})

interface Sent {
    status: string
    body: unknown
    onDataCalled: boolean
}

// `chunks` are delivered to res.onData one by one; the last one has isLast.
const send = async (
    url: string,
    headers: Record<string, string>,
    chunks: Buffer[],
): Promise<Sent> => {
    let status = ''
    let responseBody = ''
    let onDataCalled = false
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
            onDataCalled = true
            const parts = chunks.length === 0 ? [Buffer.alloc(0)] : chunks
            parts.forEach((part, i) => {
                cb(
                    part.buffer.slice(
                        part.byteOffset,
                        part.byteOffset + part.byteLength,
                    ) as ArrayBuffer,
                    i === parts.length - 1,
                )
            })
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
        endWithoutBody: () => {
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
        getMethod: () => 'post',
        getQuery: () => '',
        getParameter: () => '',
        getHeader: (name: string) => headers[name] ?? '',
        forEach: (cb: (k: string, v: string) => void) => {
            Object.entries(headers).forEach(([k, v]) => {
                cb(k, v)
            })
        },
    }
    const handler = handlers.get(`post /api/${url}`)
    if (handler === undefined) throw new Error(`no handler for ${url}`)
    await handler(res, req)
    await finished
    return {
        status,
        body: responseBody === '' ? null : (JSON.parse(responseBody) as unknown),
        onDataCalled,
    }
}

const JSON_CT = 'application/json'
const EMPTY_OBJECT_BYTES = Buffer.byteLength('{"s":""}')

// A valid JSON object of exactly `size` bytes; `tail` ends the string value.
const jsonOfSize = (size: number, tail = ''): Buffer => {
    const pad = size - EMPTY_OBJECT_BYTES - Buffer.byteLength(tail)
    const body = Buffer.from(JSON.stringify({ s: 'a'.repeat(pad) + tail }))
    expect(body.byteLength).toBe(size)
    return body
}

const split = (body: Buffer, ...at: number[]): Buffer[] => {
    const points = [0, ...at, body.byteLength]
    return points.slice(1).map((end, i) => body.subarray(points[i], end))
}

const withLength = (body: Buffer, contentType = JSON_CT) => ({
    'content-type': contentType,
    'content-length': String(body.byteLength),
})

const expect413 = (sent: Sent, limit: number, contentType: string): void => {
    expect(sent.status).toBe('413 Payload Too Large')
    expect(sent.body).toMatchObject({
        code: 'payload_too_large',
        details: { kind: 'payload_too_large', limit, contentType },
    })
    expect(controller).not.toHaveBeenCalled()
}

describe('HTTP body limits', () => {
    beforeAll(async () => {
        const { initServer } = await import('./server.js')
        await initServer({
            httpRoutes: [
                route('json', { validator: type({ s: 'string' }) }),
                route('octet', { allowedContentTypes: ['octet'] }),
                route('multipart', { allowedContentTypes: ['multipart'] }),
                route('text', { allowedContentTypes: ['text'] }),
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

    it('accepts a JSON body below the limit', async () => {
        const body = jsonOfSize(LIMITS.json - 10)
        const sent = await send('json', withLength(body), [body])

        expect(sent.status).toBe('200 OK')
    })

    describe('early rejection by Content-Length', () => {
        it('rejects Content-Length = limit + 1 without reading the body', async () => {
            const sent = await send(
                'json',
                { 'content-type': JSON_CT, 'content-length': String(LIMITS.json + 1) },
                [],
            )

            expect413(sent, LIMITS.json, JSON_CT)
            expect(sent.onDataCalled).toBe(false)
        })

        it('does not reject Content-Length = limit early', async () => {
            const body = jsonOfSize(LIMITS.json)
            const sent = await send('json', withLength(body), [body])

            expect(sent.onDataCalled).toBe(true)
            expect(sent.status).toBe('200 OK')
        })

        it('regression: whitespace around Content-Length is trimmed by getHeaders', async () => {
            const sent = await send(
                'json',
                { 'content-type': JSON_CT, 'content-length': ` ${String(LIMITS.json + 1)} ` },
                [],
            )

            expect413(sent, LIMITS.json, JSON_CT)
            expect(sent.onDataCalled).toBe(false)
        })
    })

    describe('limit while streaming (no Content-Length)', () => {
        it('accepts exactly limit bytes with a 4-byte character split between chunks', async () => {
            const body = jsonOfSize(LIMITS.json, '😀')
            const emojiStart = body.indexOf(Buffer.from('😀'))
            const sent = await send(
                'json',
                { 'content-type': JSON_CT },
                split(body, 10, emojiStart + 2),
            )

            expect(sent.status).toBe('200 OK')
            expect(received).toEqual([
                { s: 'a'.repeat(LIMITS.json - EMPTY_OBJECT_BYTES - 4) + '😀' },
            ])
        })

        it('accepts exactly limit bytes of 2-byte characters in several chunks', async () => {
            const body = jsonOfSize(LIMITS.json, 'їїї')
            const sent = await send('json', { 'content-type': JSON_CT }, split(body, 7, 21, 40))

            expect(sent.status).toBe('200 OK')
        })

        it('rejects limit + 1 bytes arriving in several chunks', async () => {
            const body = jsonOfSize(LIMITS.json + 1, 'ї')
            const sent = await send('json', { 'content-type': JSON_CT }, split(body, 20, 50))

            expect413(sent, LIMITS.json, JSON_CT)
        })

        it('rejects a body longer than its declared Content-Length', async () => {
            const body = jsonOfSize(LIMITS.json + 20)
            const sent = await send(
                'json',
                { 'content-type': JSON_CT, 'content-length': '10' },
                split(body, 30),
            )

            expect413(sent, LIMITS.json, JSON_CT)
        })
    })

    describe('limit per body kind', () => {
        it('accepts octet above the JSON limit but below the octet limit', async () => {
            const body = Buffer.alloc(LIMITS.json * 4, 1)
            const sent = await send('octet', withLength(body, 'application/octet-stream'), [body])

            expect(sent.status).toBe('200 OK')
        })

        it('rejects octet above the octet limit', async () => {
            const body = Buffer.alloc(LIMITS.octet + 1, 1)
            const sent = await send('octet', { 'content-type': 'application/octet-stream' }, [body])

            expect413(sent, LIMITS.octet, 'application/octet-stream')
        })

        it.each([
            [LIMITS.multipart, '200 OK'],
            [LIMITS.multipart + 1, '413 Payload Too Large'],
        ])('multipart of %i bytes → %s', async (size, status) => {
            const ct = 'multipart/form-data; boundary=x'
            const body = Buffer.alloc(size, 0x61)
            const sent = await send('multipart', { 'content-type': ct }, split(body, 100))

            expect(sent.status).toBe(status)
            if (status !== '200 OK') expect413(sent, LIMITS.multipart, ct)
        })

        it('rejects text/plain above the general limit', async () => {
            const body = Buffer.alloc(LIMITS.other + 1, 0x61)
            const sent = await send('text', { 'content-type': 'text/plain' }, [body])

            expect413(sent, LIMITS.other, 'text/plain')
        })
    })
})
