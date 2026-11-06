import { execFileSync } from 'node:child_process'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer, Agent } from 'node:https'
import type { Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import webpush from 'web-push'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { sendPush } from './push-transport.js'

// feat-104 (R03): the endpoint is checked before the request, so a push service that answers with
// a redirect must not move the request somewhere else. The transport (feat-139: our own
// https.request over web-push's request details) does not follow redirects and treats any status
// outside 2xx as an error. This pins that on the real transport: a local TLS server answers 302 to
// an internal address that counts its hits. feat-139 (Q4): a server that trickles its answer is
// cut by the deadline over the whole request, which an idle timeout never does.
// Needs the openssl CLI for a throwaway certificate; skipped without it.

function hasOpenssl(): boolean {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' })
        return true
    } catch {
        return false
    }
}

const listen = (server: Server): Promise<number> =>
    new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as AddressInfo).port)
        })
    })

const close = (server: Server): Promise<void> =>
    new Promise((resolve) => {
        server.close(() => {
            resolve()
        })
    })

describe.skipIf(!hasOpenssl())('web-push transport and redirects', () => {
    let dir = ''
    let cert = ''
    let key = ''
    let redirecting: Server
    let target: Server
    let targetHits = 0
    let redirectingPort = 0
    let accepting: Server
    let acceptingPort = 0
    let trickling: Server
    let tricklingPort = 0

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'push-redirect-'))
        execFileSync(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'ec',
                '-pkeyopt',
                'ec_paramgen_curve:prime256v1',
                '-nodes',
                '-keyout',
                join(dir, 'key.pem'),
                '-out',
                join(dir, 'cert.pem'),
                '-days',
                '1',
                '-subj',
                '/CN=localhost',
                '-addext',
                'subjectAltName=DNS:localhost',
            ],
            { stdio: 'ignore' },
        )
        cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
        key = readFileSync(join(dir, 'key.pem'), 'utf8')

        target = createHttpsServer({ cert, key }, (_req, res) => {
            targetHits += 1
            res.writeHead(201).end()
        })
        const targetPort = await listen(target)

        redirecting = createHttpsServer({ cert, key }, (req, res) => {
            req.resume()
            res.writeHead(302, { Location: `https://localhost:${String(targetPort)}/internal` })
            res.end()
        })
        redirectingPort = await listen(redirecting)

        accepting = createHttpsServer({ cert, key }, (req, res) => {
            req.resume()
            res.writeHead(201).end()
        })
        acceptingPort = await listen(accepting)

        // One byte every 50 ms, never done: no idle gap for a socket timeout to fire on.
        trickling = createHttpsServer({ cert, key }, (req, res) => {
            req.resume()
            res.writeHead(201)
            const timer = setInterval(() => res.write('.'), 50)
            res.on('close', () => {
                clearInterval(timer)
            })
        })
        tricklingPort = await listen(trickling)
    })

    afterAll(async () => {
        trickling.closeAllConnections()
        await close(redirecting)
        await close(target)
        await close(accepting)
        await close(trickling)
        rmSync(dir, { recursive: true, force: true })
    })

    const subscriptionTo = (port: number): webpush.PushSubscription => {
        const ecdh = createECDH('prime256v1')
        ecdh.generateKeys()
        return {
            endpoint: `https://localhost:${String(port)}/push/abc`,
            keys: {
                p256dh: ecdh.getPublicKey().toString('base64url'),
                auth: randomBytes(16).toString('base64url'),
            },
        }
    }
    const vapid = webpush.generateVAPIDKeys()
    const send = (port: number, deadlineMs = 5000): ReturnType<typeof sendPush> =>
        sendPush(subscriptionTo(port), 'hello', {
            deadlineMs,
            vapidDetails: {
                subject: 'mailto:test@example.test',
                publicKey: vapid.publicKey,
                privateKey: vapid.privateKey,
            },
            // Trusts the throwaway certificate only; the app itself passes no agent.
            agent: new Agent({ ca: cert }),
        })

    it('fails on a 302 and never requests the redirect target', async () => {
        await expect(send(redirectingPort)).rejects.toMatchObject({ statusCode: 302 })
        expect(targetHits).toBe(0)
    })

    it('resolves with the status of a 2xx answer', async () => {
        await expect(send(acceptingPort)).resolves.toEqual({ statusCode: 201 })
    })

    it('cuts an answer that trickles past the deadline', async () => {
        const started = performance.now()
        await expect(send(tricklingPort, 300)).rejects.toMatchObject({ name: 'TimeoutError' })
        expect(performance.now() - started).toBeLessThan(2000)
    })
})
