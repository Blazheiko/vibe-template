import { connect, createServer, type Server, type Socket } from 'node:net'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): a TCP proxy between the app's PostgreSQL pool
// and the test database that can lose the answer of one COMMIT for real. Armed, it watches the
// frontend messages of the wire protocol: a connection whose transaction asked for its id
// (pg_current_xact_id, what the second sign-in step keeps for reconciling) and then sends a
// simple-query COMMIT gets the COMMIT forwarded to the server; the server's answer is held back
// and both sockets are destroyed instead. The server has committed by the time it answers, so
// the app sees a dropped connection after a durable commit, every time.

interface Target {
    host: string
    port: number
}

/** The text of a simple Query ('Q') or of a Parse ('P') message, or null. */
const statementOf = (type: number, body: Buffer): string | null => {
    if (type === 0x51) return body.toString('utf8', 0, Math.max(0, body.indexOf(0)))
    if (type === 0x50) {
        // Parse: statement name \0, query \0, parameter types.
        const nameEnd = body.indexOf(0)
        const queryEnd = body.indexOf(0, nameEnd + 1)
        return nameEnd < 0 || queryEnd < 0 ? null : body.toString('utf8', nameEnd + 1, queryEnd)
    }
    return null
}

const isCommit = (text: string): boolean => /^\s*commit\s*;?\s*$/i.test(text)
const endsTransaction = (text: string): boolean => /^\s*(commit|rollback|end)\b/i.test(text)

export class CommitDropProxy {
    private server: Server | null = null
    private readonly sockets = new Set<Socket>()
    private armed = false
    /** COMMITs whose answer was dropped since the start. */
    dropped = 0

    constructor(private readonly target: Target) {}

    /** Starts listening on a free port of 127.0.0.1; answers the port. */
    async start(): Promise<number> {
        const server = createServer((client) => {
            this.pipe(client)
        })
        this.server = server
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () => {
                resolve()
            })
        })
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('no proxy port')
        return address.port
    }

    /** The next COMMIT of a transaction that read its own id loses its answer. */
    arm(): void {
        this.armed = true
    }

    disarm(): void {
        this.armed = false
    }

    async stop(): Promise<void> {
        for (const socket of this.sockets) socket.destroy()
        const server = this.server
        this.server = null
        if (server !== null)
            await new Promise<void>((resolve) => {
                server.close(() => {
                    resolve()
                })
            })
    }

    private pipe(client: Socket): void {
        const upstream = connect(this.target.port, this.target.host)
        this.sockets.add(client)
        this.sockets.add(upstream)
        const forget = (socket: Socket) => () => this.sockets.delete(socket)
        client.on('close', forget(client))
        upstream.on('close', forget(upstream))
        const destroyBoth = (): void => {
            client.destroy()
            upstream.destroy()
        }
        client.on('error', destroyBoth)
        upstream.on('error', destroyBoth)
        client.on('end', destroyBoth)
        upstream.on('end', destroyBoth)

        let pending = Buffer.alloc(0)
        // The startup message (and an SSL request before it) has no type byte.
        let startup = true
        let readsXactId = false
        let dropAnswer = false

        client.on('data', (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk])
            for (;;) {
                if (startup) {
                    if (pending.length < 8) break
                    const length = pending.readInt32BE(0)
                    if (pending.length < length) break
                    // 80877103: SSLRequest, 80877104: GSSENCRequest; the startup message follows.
                    const code = pending.readInt32BE(4)
                    if (code !== 80877103 && code !== 80877104) startup = false
                    pending = pending.subarray(length)
                    continue
                }
                if (pending.length < 5) break
                const length = pending.readInt32BE(1)
                if (pending.length < 1 + length) break
                const type = pending[0] ?? 0
                const text = statementOf(type, pending.subarray(5, 1 + length))
                pending = pending.subarray(1 + length)
                if (text === null) continue
                if (/pg_current_xact_id\s*\(/i.test(text)) readsXactId = true
                if (type === 0x51 && isCommit(text) && readsXactId && this.armed) {
                    this.armed = false
                    dropAnswer = true
                }
                if (endsTransaction(text)) readsXactId = false
            }
            upstream.write(chunk)
        })
        upstream.on('data', (chunk: Buffer) => {
            if (dropAnswer) {
                // The COMMIT reached the server and it answered: the answer never arrives.
                this.dropped += 1
                destroyBoth()
                return
            }
            client.write(chunk)
        })
    }
}
