import { connect } from 'node:net'
import {
    App,
    us_listen_socket_close,
    us_socket_local_port,
    type us_listen_socket,
} from 'uWebSockets.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-215 (security review 2026-11-12, L-14; follow-ups item 6): the report says a header
// value with a byte above 0x7E is invalid, and a check on the live stack (curl, `x-utf: café`)
// saw no line about a refused header. Here a real uWebSockets.js server gets the raw bytes from
// a socket, without curl in between, and `getHeaders` runs on the request uWS hands over.
//
// What it showed: uWS trims bytes above 0x7F at both ends of a value as it trims spaces
// (`café` arrives as `caf`, `écafe` as `cafe`), so such a value is valid by the time the
// check sees it. A byte above 0x7E inside the value arrives and is refused. Either way no
// such byte reaches the application. The edge trimming is uWS's (20.71.0); this pins it, so
// an upgrade that changes it is noticed.

const debug = vi.hoisted(() => vi.fn())
vi.mock('#logger', () => ({
    default: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}))

const { getHeaders } = await import('./http-request-handlers.js')

let listenSocket: us_listen_socket | false = false
let port = 0
let seen: Map<string, string> | undefined

beforeAll(async () => {
    const app = App().any('/*', (res, req) => {
        seen = getHeaders(req)
        res.end('ok')
    })
    await new Promise<void>((resolve, reject) => {
        app.listen('127.0.0.1', 0, (token) => {
            if (token === false) {
                reject(new Error('listen failed'))
                return
            }
            listenSocket = token
            port = us_socket_local_port(token)
            resolve()
        })
    })
})

afterAll(() => {
    if (listenSocket !== false) us_listen_socket_close(listenSocket)
})

beforeEach(() => {
    debug.mockClear()
    seen = undefined
})

/** Sends the request as these exact bytes and resolves with the raw response. */
function rawRequest(headerLines: Buffer[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1')
        const chunks: Buffer[] = []
        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
            if (Buffer.concat(chunks).includes('ok')) socket.end()
        })
        socket.on('end', () => {
            resolve(Buffer.concat(chunks).toString('latin1'))
        })
        socket.on('error', reject)
        socket.write(
            Buffer.concat([
                Buffer.from('GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\n'),
                ...headerLines.map((line) => Buffer.concat([line, Buffer.from('\r\n')])),
                Buffer.from('Connection: close\r\n\r\n'),
            ]),
        )
    })
}

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8')

describe('header values on a live uWebSockets.js server', () => {
    it('refuses a value with a byte above 0x7E inside it, and an invalid name, in one debug line', async () => {
        const response = await rawRequest([
            utf8('x-utf: caféXYZ tail'),
            utf8('x.bad: 1'),
            utf8('x-good: plain'),
        ])

        expect(response.startsWith('HTTP/1.1 200')).toBe(true)
        expect(seen?.get('x-good')).toBe('plain')
        expect(seen?.has('x-utf')).toBe(false)
        expect(seen?.has('x.bad')).toBe(false)
        expect(debug).toHaveBeenCalledTimes(1)
        expect(debug).toHaveBeenCalledWith(
            { invalid: 2, names: ['x-utf', 'x.bad'] },
            'Invalid headers skipped',
        )
    })

    it('gets values whose bytes above 0x7F at the ends were trimmed by uWS, as spaces are', async () => {
        await rawRequest([
            utf8('x-trail: café'),
            utf8('x-lead: écafe'),
            utf8('x-only: éé'),
            Buffer.concat([utf8('x-latin1: caf'), Buffer.from([0xe9])]),
        ])

        expect(seen?.get('x-trail')).toBe('caf')
        expect(seen?.get('x-lead')).toBe('cafe')
        expect(seen?.get('x-only')).toBe('')
        expect(seen?.get('x-latin1')).toBe('caf')
        expect(debug).not.toHaveBeenCalled()
    })
})
