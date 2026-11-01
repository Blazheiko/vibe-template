import { connect, createServer, type Socket } from 'node:net'

// Raw-socket HTTP/1.1 helpers for tests that need exact control of the bytes that go
// out and when (chunked bodies that never finish, headers without a body, ...), which
// fetch() cannot express.

export const getFreePort = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address()
            probe.close(() => {
                resolve(typeof address === 'object' && address !== null ? address.port : 0)
            })
        })
    })

export interface RawResponse {
    statusLine: string
    headers: Map<string, string>
    body: string
}

// Parses one full HTTP/1.1 response framed by Content-Length.
const tryParse = (data: Buffer): RawResponse | null => {
    const headerEnd = data.indexOf('\r\n\r\n')
    if (headerEnd === -1) return null
    const [statusLine = '', ...lines] = data.subarray(0, headerEnd).toString().split('\r\n')
    const headers = new Map<string, string>()
    for (const line of lines) {
        const colon = line.indexOf(':')
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
    }
    const length = Number(headers.get('content-length') ?? '0')
    const body = data.subarray(headerEnd + 4)
    if (body.byteLength < length) return null
    return { statusLine, headers, body: body.subarray(0, length).toString() }
}

/**
 * Opens a socket, lets `write` send bytes, and resolves with the first full
 * response. A timer rejects the wait, so a hung server fails the test instead
 * of blocking the run; `finally` always clears the timer and destroys the socket.
 */
export const exchange = async (
    port: number,
    write: (socket: Socket) => void,
    timeoutMs = 2_000,
): Promise<RawResponse> => {
    let socket: Socket | undefined
    let timer: NodeJS.Timeout | undefined
    try {
        return await new Promise<RawResponse>((resolve, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`no full response within ${String(timeoutMs)} ms`))
            }, timeoutMs)
            let data = Buffer.alloc(0)
            socket = connect(port, '127.0.0.1', () => {
                if (socket !== undefined) write(socket)
            })
            socket.on('data', (chunk: Buffer) => {
                data = Buffer.concat([data, chunk])
                const parsed = tryParse(data)
                if (parsed !== null) resolve(parsed)
            })
            socket.on('error', reject)
            socket.on('close', () => {
                reject(new Error('connection closed before a full response'))
            })
        })
    } finally {
        clearTimeout(timer)
        socket?.destroy()
    }
}

/** A multipart/form-data body with one file field. */
export const multipartBody = (
    fileBytes: number,
    boundary = '----testboundary',
): { body: Buffer; contentType: string } => {
    const head = Buffer.from(
        `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="file"; filename="a.bin"\r\n' +
            'Content-Type: application/octet-stream\r\n\r\n',
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    return {
        body: Buffer.concat([head, Buffer.alloc(fileBytes, 0x61), tail]),
        contentType: `multipart/form-data; boundary=${boundary}`,
    }
}

export interface StreamResult {
    /** The answer, or null when the server reset the connection before the client read it. */
    response: RawResponse | null
    /** Bytes the client managed to write before the server answered (or all of them). */
    bytesWritten: number
    /**
     * The server closed the connection on a client that was still sending. That is how a
     * server refuses an oversized body, and the TCP reset can reach the client before it
     * has read the answer, so a refusal is either a 413 or a reset.
     */
    reset: boolean
}

/**
 * Streams a chunked request body of up to `totalBytes` in `chunkBytes` pieces and stops
 * as soon as the server has answered. `bytesWritten` is then roughly how much the server
 * was willing to read: a server that refuses at its limit answers long before the end.
 */
export const streamUntilAnswered = (
    port: number,
    path: string,
    contentType: string,
    totalBytes: number,
    chunkBytes = 256 * 1024,
    timeoutMs = 15_000,
): Promise<StreamResult> =>
    new Promise<StreamResult>((resolve, reject) => {
        const chunk = Buffer.alloc(chunkBytes, 0x61)
        const framed = Buffer.concat([
            Buffer.from(`${chunkBytes.toString(16)}\r\n`),
            chunk,
            Buffer.from('\r\n'),
        ])
        let answered: RawResponse | null = null
        let received = Buffer.alloc(0)
        let sent = 0
        const socket = connect(port, '127.0.0.1', () => {
            socket.write(
                `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ${contentType}\r\n` +
                    'Transfer-Encoding: chunked\r\n\r\n',
            )
            pump()
        })
        const timer = setTimeout(() => {
            socket.destroy()
            reject(new Error(`no answer within ${String(timeoutMs)} ms`))
        }, timeoutMs)
        let done = false
        const finish = (reset: boolean): void => {
            if (done) return
            done = true
            clearTimeout(timer)
            resolve({ response: answered, bytesWritten: socket.bytesWritten, reset })
            socket.destroy()
        }
        const pump = (): void => {
            while (answered === null && sent < totalBytes) {
                sent += chunkBytes
                if (!socket.write(framed)) {
                    socket.once('drain', pump)
                    return
                }
            }
            if (answered === null) {
                // Everything was sent without an answer: close the body, wait for it.
                socket.write('0\r\n\r\n')
            }
        }
        socket.on('data', (data: Buffer) => {
            received = Buffer.concat([received, data])
            const parsed = tryParse(received)
            if (parsed !== null && answered === null) {
                answered = parsed
                finish(false)
            }
        })
        socket.on('error', () => {
            finish(true)
        })
        socket.on('close', () => {
            finish(true)
        })
    })
