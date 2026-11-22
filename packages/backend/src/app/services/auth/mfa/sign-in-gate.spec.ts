import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4, «Одна точка входу»): every place that creates a
// signed-in session is known, and every one that a returning account reaches asks the second-step
// gate first. A new call of auth.login( or of the second-step session writes fails this test until
// it is listed here with the reason it is safe.

const APP = fileURLToPath(new URL('../../../', import.meta.url))

const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return sourceFiles(path)
        return path.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(path) ? [path] : []
    })

/** `<file>: <enclosing function>` of every match. */
function callSites(pattern: RegExp): string[] {
    const sites: string[] = []
    for (const file of sourceFiles(APP)) {
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, index) => {
            if (!pattern.test(line)) return
            let name = '?'
            for (let i = index; i >= 0; i--) {
                const match = /^(?:export )?(?:async )?function (\w+)|^ {4}async (\w+)\(/.exec(
                    lines[i] ?? '',
                )
                if (match !== null) {
                    name = match[1] ?? match[2] ?? '?'
                    break
                }
            }
            sites.push(`${relative(APP, file)}: ${name}`)
        })
    }
    return sites.sort()
}

describe('sign-in call sites (feat-245 Р4)', () => {
    it('auth.login( is called only where a session may be created without a second step', () => {
        expect(callSites(/\bauth\.login\(/)).toEqual([
            // Password sign-in (gated in `login`), registrations (a new account has no factor).
            'services/auth/auth-service.ts: buildAuthSuccess',
            // A renewal of a session that already passed its sign-in; it keeps its auth state.
            'services/auth/auth-service.ts: renewSession',
            // feat-246 (Р6): a passkey with user verification is itself a level-2 sign-in.
            'services/auth/mfa/passkey-sign-in.ts: verify',
            // The mailed link confirmation (gated in the same function, below the claim).
            'services/auth/oauth-service.ts: confirmLink',
            // Every OAuth sign-in (gated in the same function).
            'services/auth/oauth-service.ts: finishSignIn',
        ])
    })

    it('the second-step session writes are used only by the second step', () => {
        expect(callSites(/\.(prepareLogin|activateLogin)\(/)).toEqual([
            'services/auth/mfa/mfa-sign-in.ts: activate',
            'services/auth/mfa/mfa-sign-in.ts: attempt',
        ])
    })

    it('the gated sign-ins ask the second-step gate before auth.login(', () => {
        const auth = readFileSync(join(APP, 'services/auth/auth-service.ts'), 'utf8')
        const login = auth.slice(
            auth.indexOf('    async login('),
            auth.indexOf('    async logout('),
        )
        expect(login.indexOf('startSecondStepIfRequired(')).toBeGreaterThan(-1)
        expect(login.indexOf('startSecondStepIfRequired(')).toBeLessThan(
            login.indexOf('buildAuthSuccess('),
        )

        const oauth = readFileSync(join(APP, 'services/auth/oauth-service.ts'), 'utf8')
        const finish = oauth.slice(oauth.indexOf('async function finishSignIn('))
        expect(finish.indexOf('startSecondStepIfRequired(')).toBeLessThan(
            finish.indexOf('auth.login('),
        )
        const confirm = oauth.slice(oauth.indexOf('    async confirmLink('))
        expect(confirm.indexOf('startSecondStepIfRequired(')).toBeLessThan(
            confirm.indexOf('auth.login('),
        )
    })
})
