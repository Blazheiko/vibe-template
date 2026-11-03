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

// feat-104 (R03): the endpoint is checked before the request, so a push service that answers with
// a redirect must not move the request somewhere else. web-push sends with https.request, which
// does not follow redirects, and treats any status outside 2xx as an error. This pins that on the
// real transport: a local TLS server answers 302 to an internal address that counts its hits.
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
    })

    afterAll(async () => {
        await close(redirecting)
        await close(target)
        rmSync(dir, { recursive: true, force: true })
    })

    it('fails on a 302 and never requests the redirect target', async () => {
        const ecdh = createECDH('prime256v1')
        ecdh.generateKeys()
        const vapid = webpush.generateVAPIDKeys()

        const send = webpush.sendNotification(
            {
                endpoint: `https://localhost:${String(redirectingPort)}/push/abc`,
                keys: {
                    p256dh: ecdh.getPublicKey().toString('base64url'),
                    auth: randomBytes(16).toString('base64url'),
                },
            },
            'hello',
            {
                vapidDetails: {
                    subject: 'mailto:test@example.test',
                    publicKey: vapid.publicKey,
                    privateKey: vapid.privateKey,
                },
                // Trusts the throwaway certificate only; the app itself passes no agent.
                agent: new Agent({ ca: cert }),
            },
        )

        await expect(send).rejects.toMatchObject({ statusCode: 302 })
        expect(targetHits).toBe(0)
    })
})
