import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6; tasks P2): every WebAuthn answer is checked by
// verifyWebAuthnCeremony, so registration, passwordless sign-in, the second step and step-up
// share one set of checks. No other module may call the library's verify functions.

const SRC = fileURLToPath(new URL('../../../../', import.meta.url))
const CEREMONY = 'app/services/auth/mfa/webauthn-ceremony.ts'

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return sources(path)
        return name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(name) ? [path] : []
    })
}

describe('WebAuthn verification has one door', () => {
    it('only webauthn-ceremony.ts imports the server library', () => {
        const importers = sources(SRC)
            .filter((path) => readFileSync(path, 'utf8').includes("from '@simplewebauthn/server'"))
            .map((path) => relative(SRC, path))
        expect(importers).toEqual([CEREMONY])
    })

    it('nothing calls the library verify functions but that module', () => {
        const callers = sources(SRC)
            .filter((path) =>
                /verify(Registration|Authentication)Response\(/.test(readFileSync(path, 'utf8')),
            )
            .map((path) => relative(SRC, path))
        expect(callers).toEqual([CEREMONY])
    })
})
