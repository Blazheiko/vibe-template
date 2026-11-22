import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): the admin channel is published to only through
// broadcastService.broadcastMessageToChannel, which drops the subscribers past their staff
// deadline right before the publish. Nothing else may reach the uWS topic.

const SRC = fileURLToPath(new URL('../../../', import.meta.url))
const BROADCAST = 'app/services/communication/broadcast-service.ts'
const SERVER = 'vendor/start/server.ts'

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return sources(path)
        return name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(name) ? [path] : []
    })
}

const filesMatching = (pattern: RegExp): string[] =>
    sources(SRC)
        .filter((path) => pattern.test(readFileSync(path, 'utf8')))
        .map((path) => relative(SRC, path))

describe('the admin channel has one publish', () => {
    it('only the server publishes to a uWS topic', () => {
        expect(filesMatching(/\b(server|app|ws)\.publish\(/)).toEqual([SERVER])
    })

    it('only the broadcast service calls broadcastToChannel', () => {
        expect(filesMatching(/\bbroadcastToChannel\(/).filter((path) => path !== SERVER)).toEqual([
            BROADCAST,
        ])
    })

    it('the broadcast service drops the expired subscribers right before that call', () => {
        const source = readFileSync(join(SRC, BROADCAST), 'utf8')
        const body = source.slice(source.indexOf('broadcastMessageToChannel('))
        const drop = body.indexOf('adminChannelSubscribers.dropExpired(')
        const publish = body.indexOf('broadcastToChannel(')
        expect(drop).toBeGreaterThan(-1)
        expect(publish).toBeGreaterThan(drop)
        // Nothing awaited between them.
        expect(body.slice(drop, publish)).not.toMatch(/\bawait\b|\.then\(/)
    })

    it('nothing else subscribes a socket to the admin topic', () => {
        expect(filesMatching(/\.subscribe\(ADMIN_CHANNEL\)|\.subscribe\('admin'\)/)).toEqual([
            'app/services/admin/admin-ws-channel-service.ts',
        ])
    })
})
