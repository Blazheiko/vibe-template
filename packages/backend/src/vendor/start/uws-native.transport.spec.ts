import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import * as uWS from 'uWebSockets.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { exchangeUntilClose, getFreePort, writeLater } from '../../test-support/raw-http.js'

/**
 * feat-277: uWebSockets.js v20.72.0 (core v20.81.0) itself, on a bare uWS app with no
 * code of ours in front, so each test shows what the library does:
 * - which malformed requests it refuses before any route handler runs, and which
 *   only after the handler has been called (documentation/backend/request-lifecycle.md);
 * - onWritable (#1325, the callback now lives in inline storage): a static file streamed
 *   from disk to a client that does not read at first must resume and arrive whole;
 * - the string writer (#1335–#1354) on ws.send: UTF-8 text arrives byte for byte.
 */

vi.mock('#config/app.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return { default: { ...actual.default, env: 'manual-test', serveStatic: true } }
})

const { staticCacheHandler } = await import('./static-server.js')
type Entry = Parameters<typeof staticCacheHandler>[2]

const PORT = await getFreePort()
// Far more than the socket buffers on both ends, so tryEnd has to report backpressure.
const FILE = randomBytes(16 * 1024 * 1024)
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

// Cyrillic, CJK, emoji (surrogate pairs in JS), a combining mark; and a long variant
// (about 2.2 MiB of UTF-8).
const MIXED = 'Привіт, світе! 你好 😀🚀👩‍💻 é '
const LONG = MIXED.repeat(40_000)
// Room for LONG in one send, so a small socket buffer on a CI runner cannot make uWS drop it.
const WS_MAX_BACKPRESSURE = 16 * 1024 * 1024

let dir: string
let entry: Entry
let listenSocket: uWS.us_listen_socket | false = false
let writableCalls = 0
let anyCalls: string[] = []

beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uws-stream-'))
    const filePath = path.join(dir, 'big.bin')
    await fs.writeFile(filePath, FILE)
    entry = { kind: 'disk', filePath, size: FILE.byteLength, etag: '"big"' }

    const app = uWS.App()
    app.get('/big.bin', (res, req) => {
        // Count the waits for writability without changing what the handler does.
        const onWritable = res.onWritable.bind(res)
        res.onWritable = (handler: (offset: number) => boolean) => {
            writableCalls += 1
            return onWritable(handler)
        }
        void staticCacheHandler(res, req, entry)
    })
    // An empty string through the native writer (uWebSockets.js #1338: the pool's end).
    app.get('/empty', (res) => {
        res.end('')
    })
    // Every other request: records that the handler ran and how the request ended.
    app.any('/*', (res) => {
        anyCalls.push('handler')
        res.onAborted(() => anyCalls.push('aborted'))
        res.onData((_chunk, isLast) => {
            if (isLast) {
                anyCalls.push('body end')
                res.cork(() => res.end('ok'))
            }
        })
    })
    app.ws<{ kind: string }>('/ws/:kind', {
        maxPayloadLength: WS_MAX_BACKPRESSURE,
        maxBackpressure: WS_MAX_BACKPRESSURE,
        upgrade: (res, req, context) => {
            res.upgrade(
                { kind: req.getParameter(0) ?? '' },
                req.getHeader('sec-websocket-key'),
                req.getHeader('sec-websocket-protocol'),
                req.getHeader('sec-websocket-extensions'),
                context,
            )
        },
        open: (ws) => {
            const kind = ws.getUserData().kind
            if (kind === 'echo') return
            ws.send(kind === 'long' ? LONG : kind === 'empty' ? '' : MIXED, false)
        },
        message: (ws, message, isBinary) => {
            // Back as a JS string, so the writer encodes it again.
            ws.send(Buffer.from(message).toString('utf8'), isBinary)
        },
    })
    listenSocket = await new Promise<uWS.us_listen_socket | false>((resolve) => {
        app.listen('127.0.0.1', PORT, resolve)
    })
    expect(listenSocket).not.toBe(false)
})

afterAll(async () => {
    if (listenSocket !== false) uWS.us_listen_socket_close(listenSocket)
    await fs.rm(dir, { recursive: true, force: true })
})

interface Download {
    head: string
    body: Buffer
}

/**
 * GET with a client that reads nothing for `pauseMs`, then everything up to Content-Length.
 * The chunks are kept in a list and joined once: joining on every chunk would copy the
 * 16 MiB body hundreds of times.
 */
const slowDownload = (pauseMs: number, timeoutMs = 20_000): Promise<Download> =>
    new Promise<Download>((resolve, reject) => {
        let head: Buffer = Buffer.alloc(0)
        let headText: string | null = null
        let length = Number.NaN
        const bodyChunks: Buffer[] = []
        let bodyBytes = 0
        let done = false
        const finish = (error: Error | null): void => {
            if (done) return
            done = true
            clearTimeout(timer)
            clearTimeout(resumeTimer)
            socket.destroy()
            if (error !== null) {
                reject(error)
                return
            }
            resolve({
                head: headText ?? '',
                body: Buffer.concat(bodyChunks, bodyBytes).subarray(0, length),
            })
        }
        let resumeTimer: NodeJS.Timeout | undefined
        const socket = connect(PORT, '127.0.0.1', () => {
            socket.write('GET /big.bin HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
            socket.pause()
            resumeTimer = setTimeout(() => {
                if (!socket.destroyed) socket.resume()
            }, pauseMs)
        })
        const timer = setTimeout(() => {
            finish(new Error(`download not complete within ${String(timeoutMs)} ms`))
        }, timeoutMs)
        socket.on('data', (chunk: Buffer) => {
            if (headText === null) {
                head = Buffer.concat([head, chunk])
                const headerEnd = head.indexOf('\r\n\r\n')
                if (headerEnd === -1) return
                headText = head.subarray(0, headerEnd).toString()
                length = Number(/content-length:\s*(\d+)/i.exec(headText)?.[1] ?? 'NaN')
                if (!Number.isFinite(length)) {
                    finish(new Error(`no Content-Length in: ${headText}`))
                    return
                }
                chunk = head.subarray(headerEnd + 4)
            }
            bodyChunks.push(chunk)
            bodyBytes += chunk.byteLength
            if (bodyBytes >= length) finish(null)
        })
        socket.on('error', (err) => {
            finish(err)
        })
        socket.on('close', () => {
            finish(
                new Error(
                    `connection closed after ${String(bodyBytes)} of ${String(length)} body bytes`,
                ),
            )
        })
    })

const refusal = async (raw: string | Buffer, laterRaw?: string) => {
    anyCalls = []
    const result = await exchangeUntilClose(PORT, (socket) => {
        socket.write(raw)
        if (laterRaw !== undefined) writeLater(socket, laterRaw, 100)
    })
    // Let onAborted run after the close.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return result
}

const expectUws400 = (result: Awaited<ReturnType<typeof refusal>>): void => {
    expect(result.response?.statusLine).toBe('HTTP/1.1 400 Bad Request')
    expect(result.response?.headers.get('connection')).toBe('close')
    expect(result.closedByServer).toBe(true)
}

describe('requests uWS refuses before any handler runs (class 1)', () => {
    it.each([
        [
            'raw UTF-8 in the target',
            Buffer.concat([
                Buffer.from('GET /'),
                Buffer.from('п', 'utf8'),
                Buffer.from(' HTTP/1.1\r\nHost: a\r\n\r\n'),
            ]),
        ],
        ['Host with a path', 'GET / HTTP/1.1\r\nHost: a/b\r\n\r\n'],
        ['Host with a query', 'GET / HTTP/1.1\r\nHost: a?b\r\n\r\n'],
        ['Host with a fragment', 'GET / HTTP/1.1\r\nHost: a#b\r\n\r\n'],
    ])('%s: 400, closed, no handler', async (_name, raw) => {
        const result = await refusal(raw)

        expectUws400(result)
        expect(anyCalls).toEqual([])
    })
})

const CHUNKED_POST = 'POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n'

describe('requests uWS refuses only after the handler ran (class 2)', () => {
    it.each(['POST', 'DELETE', 'GET'])(
        '%s with a Content-Length of 2^56 or more: the handler runs, then 400 and abort',
        async (method) => {
            const result = await refusal(
                `${method} / HTTP/1.1\r\nHost: a\r\nContent-Length: 72057594037927936\r\n\r\n`,
            )

            expectUws400(result)
            expect(anyCalls).toEqual(['handler', 'aborted'])
        },
    )

    it('a bare-LF trailer in the same packet as the body: the body has already ended', async () => {
        const result = await refusal(`${CHUNKED_POST}0\r\nX: y\n\r\n`)

        expectUws400(result)
        expect(anyCalls.slice(0, 2)).toEqual(['handler', 'body end'])
    })

    it('the last data chunk first, then "0" and the bare-LF trailer: the body ends with them', async () => {
        const result = await refusal(CHUNKED_POST, '0\r\nX: y\n\r\n')

        expectUws400(result)
        expect(anyCalls.slice(0, 2)).toEqual(['handler', 'body end'])
    })

    it('"0" first, the bare-LF trailer later: the answer to the ended body goes out, then the close', async () => {
        const result = await refusal(`${CHUNKED_POST}0\r\n`, 'X: y\n\r\n')

        expect(result.response?.statusLine).toBe('HTTP/1.1 200 OK')
        expect(result.closedByServer).toBe(true)
        expect(anyCalls.slice(0, 2)).toEqual(['handler', 'body end'])
    })
})

describe('an empty string through the native writer (uWebSockets.js #1338)', () => {
    it("res.end(''): 200 with Content-Length: 0 and no body", async () => {
        const result = await exchangeUntilClose(PORT, (socket) => {
            socket.write('GET /empty HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n')
        })

        expect(result.response?.statusLine).toBe('HTTP/1.1 200 OK')
        expect(result.response?.headers.get('content-length')).toBe('0')
        expect(result.response?.bodyBytes.byteLength).toBe(0)
        // Nothing after the headers either.
        expect(result.bytes.subarray(result.bytes.indexOf('\r\n\r\n') + 4).byteLength).toBe(0)
    })
})

describe('static streaming with backpressure on a real uWS (onWritable)', () => {
    it('resumes through onWritable and delivers the whole file to a slow client', async () => {
        writableCalls = 0

        const { head, body } = await slowDownload(300)

        expect(head.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
        expect(body.byteLength).toBe(FILE.byteLength)
        expect(sha256(body)).toBe(sha256(FILE))
        // tryEnd did not fit at least once, and the write went on from onWritable.
        expect(writableCalls).toBeGreaterThan(0)
    })
})

const receiveText = (url: string, send?: string): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${String(PORT)}${url}`)
        const timer = setTimeout(() => {
            ws.close()
            reject(new Error('no WebSocket message'))
        }, 10_000)
        ws.addEventListener('open', () => {
            if (send !== undefined) ws.send(send)
        })
        ws.addEventListener('message', (event: MessageEvent) => {
            clearTimeout(timer)
            ws.close()
            resolve(Buffer.from(String(event.data), 'utf8'))
        })
        ws.addEventListener('error', () => {
            clearTimeout(timer)
            reject(new Error('WebSocket error'))
        })
    })

describe('ws.send of UTF-8 text on a real uWS', () => {
    it.each([
        ['mixed', MIXED],
        ['long', LONG],
    ])('sends the %s text byte for byte', async (kind, expected) => {
        const received = await receiveText(`/ws/${kind}`)

        expect(received.equals(Buffer.from(expected, 'utf8'))).toBe(true)
    })

    it("ws.send(''): an empty text message arrives", async () => {
        const received = await receiveText('/ws/empty')

        expect(received.byteLength).toBe(0)
    })

    it('echoes UTF-8 text back unchanged', async () => {
        const received = await receiveText('/ws/echo', MIXED)

        expect(received.equals(Buffer.from(MIXED, 'utf8'))).toBe(true)
    })
})
