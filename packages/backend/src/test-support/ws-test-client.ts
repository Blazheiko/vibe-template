import { sleep } from './redis-test-client.js'

// A WebSocket client for tests against a real server: collects the frames it receives and
// can send a request and wait for the reply that carries the same event and timestamp.

export interface Frame {
    event?: string
    status?: string | number
    timestamp?: number
    /** The reply to a request. */
    data?: unknown
    /** The payload of a pushed `broadcast:*` event. */
    payload?: unknown
    error?: { code?: string; message?: string } | null
}

export class WsTestClient {
    readonly frames: Frame[] = []
    closed = false
    private requests = 0

    protected constructor(readonly ws: WebSocket) {
        ws.addEventListener('message', (message) => {
            this.frames.push(JSON.parse(String(message.data)) as Frame)
        })
        ws.addEventListener('close', () => {
            this.closed = true
        })
    }

    /** Opens a connection with the token in Sec-WebSocket-Protocol, as the frontend does. */
    protected static async open<T extends WsTestClient>(
        make: (ws: WebSocket) => T,
        port: number,
        token: string,
        opened: WebSocket[],
    ): Promise<T> {
        const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/api/websocket`, [token])
        opened.push(ws)
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => {
                resolve()
            })
            ws.addEventListener('error', () => {
                reject(new Error('websocket failed to open'))
            })
        })
        const client = make(ws)
        await client.waitFor((frame) => frame.event === 'service:connection_established')
        return client
    }

    async waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
        const started = Date.now()
        for (;;) {
            const found = this.frames.find(predicate)
            if (found !== undefined) return found
            if (Date.now() - started > timeoutMs) {
                throw new Error(
                    `no matching frame in ${String(timeoutMs)} ms: ${JSON.stringify(this.frames)}`,
                )
            }
            await sleep(20)
        }
    }

    /** Sends a request and returns the reply that carries the same event and timestamp. */
    async request(event: string, payload: Record<string, unknown> | null = null): Promise<Frame> {
        this.requests += 1
        const timestamp = Date.now() * 1000 + this.requests
        this.ws.send(JSON.stringify({ event, payload, timestamp }))
        return this.waitFor((frame) => frame.event === event && frame.timestamp === timestamp)
    }

    received(event: string): number {
        return this.frames.filter((frame) => frame.event === event).length
    }
}
