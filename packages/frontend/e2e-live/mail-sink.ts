import net from 'node:net'

/**
 * The smallest SMTP server that nodemailer will talk to: no TLS, no auth, every message kept in
 * memory. The backend under test sends its mail here (SMTP_IGNORE_TLS=true), so a test can read
 * the link a user would click. It understands EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT.
 */

export interface Mail {
    to: string[]
    /** The message as sent, headers and body. */
    raw: string
    /** The readable text: quoted-printable and base64 parts decoded. */
    text: string
}

const decodeQuotedPrintable = (value: string): string =>
    value
        .replaceAll(/=\r?\n/g, '')
        .replaceAll(/=([\dA-F]{2})/gi, (_match, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
        )

/** Decodes the body parts the way a mail client would show them (good enough for ASCII links). */
export function readableText(raw: string): string {
    const parts = raw.split(/\r?\n(?=--)/)
    const decoded = parts.map((part) => {
        const [head = '', ...rest] = part.split(/\r?\n\r?\n/)
        const body = rest.join('\n\n')
        if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
            return decodeQuotedPrintable(body)
        }
        if (/content-transfer-encoding:\s*base64/i.test(head)) {
            return Buffer.from(body.replaceAll(/\s+/g, ''), 'base64').toString('utf8')
        }
        return part
    })
    return decoded.join('\n')
}

export class MailSink {
    readonly mails: Mail[] = []
    private server: net.Server | null = null

    start(port: number): Promise<void> {
        this.server = net.createServer((socket) => {
            this.serve(socket)
        })
        return new Promise((resolve, reject) => {
            this.server?.once('error', reject)
            this.server?.listen(port, '127.0.0.1', resolve)
        })
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server === null) {
                resolve()
                return
            }
            this.server.close(() => {
                resolve()
            })
            this.server = null
        })
    }

    clear(): void {
        this.mails.length = 0
    }

    /** The newest mail sent to `address`, waiting up to `timeoutMs` for it to arrive. */
    async mailTo(address: string, timeoutMs = 10_000): Promise<Mail> {
        const wanted = address.toLowerCase()
        const deadline = Date.now() + timeoutMs
        for (;;) {
            const found = [...this.mails]
                .reverse()
                .find((mail) => mail.to.some((to) => to.toLowerCase().includes(wanted)))
            if (found !== undefined) return found
            if (Date.now() > deadline) {
                throw new Error(`No mail to ${address} within ${String(timeoutMs)} ms`)
            }
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
    }

    private serve(socket: net.Socket): void {
        let buffer = ''
        let recipients: string[] = []
        let data: string[] | null = null

        const reply = (line: string): void => {
            socket.write(`${line}\r\n`)
        }
        reply('220 mail-sink ESMTP')

        socket.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8')
            for (;;) {
                if (data !== null) {
                    const end = buffer.indexOf('\r\n.\r\n')
                    if (end === -1) return
                    const raw = buffer.slice(0, end).replaceAll('\r\n..', '\r\n.')
                    buffer = buffer.slice(end + 5)
                    this.mails.push({ to: recipients, raw, text: readableText(raw) })
                    recipients = []
                    data = null
                    reply('250 OK queued')
                    continue
                }
                const eol = buffer.indexOf('\r\n')
                if (eol === -1) return
                const line = buffer.slice(0, eol)
                buffer = buffer.slice(eol + 2)
                const command = line.toUpperCase()
                if (command.startsWith('EHLO')) {
                    socket.write('250-mail-sink\r\n250 8BITMIME\r\n')
                } else if (command.startsWith('HELO')) {
                    reply('250 mail-sink')
                } else if (command.startsWith('MAIL FROM')) {
                    recipients = []
                    reply('250 OK')
                } else if (command.startsWith('RCPT TO')) {
                    recipients.push(/<([^>]*)>/.exec(line)?.[1] ?? line.slice(8).trim())
                    reply('250 OK')
                } else if (command === 'DATA') {
                    data = []
                    reply('354 End data with <CR><LF>.<CR><LF>')
                } else if (command === 'RSET') {
                    recipients = []
                    reply('250 OK')
                } else if (command === 'NOOP') {
                    reply('250 OK')
                } else if (command === 'QUIT') {
                    reply('221 Bye')
                    socket.end()
                    return
                } else {
                    reply('502 Command not implemented')
                }
            }
        })
        socket.on('error', () => {
            socket.destroy()
        })
    }
}
