import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р10, Р11): every place where staff meets MFA asks
// one policy, `staffMfaPolicy` of shared, through services/auth/mfa/staff-policy.ts, so the
// passkey mode of feat-248 changes behaviour in one place.

const SRC = fileURLToPath(new URL('../../../../', import.meta.url))
const POLICY = 'app/services/auth/mfa/staff-policy.ts'

const CONSUMERS = [
    'app/middlewares/permission-guard.ts',
    'app/middlewares/ws-permission-guard.ts',
    'app/websocket/ws-role-sync.ts',
    'app/services/admin/admin-ws-channel-service.ts',
    'app/services/user/role-assignment-service.ts',
    'app/services/auth/mfa/mfa-reset-service.ts',
    // feat-248 (Р12): meetsStaffMfa and the factor removals.
    'app/services/auth/sign-in-methods-service.ts',
    'app/services/auth/mfa/totp-service.ts',
    'app/services/auth/mfa/passkey-service.ts',
]

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return sources(path)
        return name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(name) ? [path] : []
    })
}

const IMPORTS_POLICY = /from '(#app\/services\/auth\/mfa\/|\.\/)staff-policy\.js'/

describe('the staff MFA policy has one source', () => {
    it.each(CONSUMERS)('%s imports the staff policy', (path) => {
        expect(readFileSync(join(SRC, path), 'utf8')).toMatch(IMPORTS_POLICY)
    })

    it('only staff-policy.ts builds the shared policy', () => {
        const builders = sources(SRC)
            .filter((path) =>
                /\bstaffMfaPolicy\(|\bstaffSessionOk\(/.test(readFileSync(path, 'utf8')),
            )
            .map((path) => relative(SRC, path))
        expect(builders).toEqual([POLICY])
    })

    it('staff-policy.ts takes it from shared/mfa', () => {
        const source = readFileSync(join(SRC, POLICY), 'utf8')
        expect(source).toMatch(/import \{[^}]*\bstaffMfaPolicy\b[^}]*\} from 'shared\/mfa'/)
    })
})
