import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { readEnvValue, upsertEnvValues } from './env-file.js'
import { parseMfaKeysArgs } from './mfa-keys-args.js'
import { checkMfaKeys, newMfaKeys, rotateMfaKeys } from './mfa-keys-list.js'

// feat-260. Usage:
//   pnpm --filter backend mfa:keys                    print a new value (one key, k1)
//   pnpm --filter backend mfa:keys --write            save it to packages/backend/.env
//   pnpm --filter backend mfa:keys --rotate           print the current value with a new key first
//   pnpm --filter backend mfa:keys --rotate --write   rotate the value in packages/backend/.env
//   pnpm --filter backend mfa:keys --check            validate the current value
//
// The current value is MFA_ENCRYPTION_KEYS of the shell when it is set, else the one in .env;
// with --write it is always the one in .env. Keep every old key: a TOTP secret sealed with a
// dropped key can no longer be read, and its owner has to set the factor up again.

function fail(message: string): never {
    console.error(message)
    process.exit(1)
}

function readArgs(): ReturnType<typeof parseMfaKeysArgs> {
    try {
        return parseMfaKeysArgs(process.argv.slice(2))
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
    }
}

const { mode, write } = readArgs()

const envPath = resolve(process.cwd(), '.env')
const content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const fromFile = readEnvValue(content, 'MFA_ENCRYPTION_KEYS')
const fromShell = (process.env['MFA_ENCRYPTION_KEYS'] ?? '').trim()
const useShell = !write && fromShell !== ''
const current = useShell ? fromShell : fromFile
const source = useShell ? 'MFA_ENCRYPTION_KEYS of the shell' : envPath

if (mode === 'check') {
    const checked = checkMfaKeys(current)
    if (!checked.ok) fail(`${source}: ${checked.error}`)
    const [writer, ...readers] = checked.ids
    console.log(`${source}: valid, ${String(checked.ids.length)} key(s).`)
    console.log(`New TOTP secrets are encrypted with "${String(writer)}".`)
    if (readers.length > 0) console.log(`Also read: ${readers.join(', ')}.`)
    process.exit(0)
}

let value: string
let note: string
if (mode === 'rotate') {
    const rotated = rotateMfaKeys(current)
    if (!rotated.ok) fail(`${source}: ${rotated.error}. Run without --rotate for a first key.`)
    value = rotated.value
    note = `New key "${rotated.id}" encrypts from now on; every key before it still reads.`
} else {
    if (write && fromFile !== '') {
        fail(
            `MFA_ENCRYPTION_KEYS is already set in ${envPath}. Replacing it makes every TOTP ` +
                'factor unreadable; run with --rotate to add a key and keep the current ones.',
        )
    }
    value = newMfaKeys()
    note = 'One key, "k1".'
}

if (!write) {
    console.log(
        'Set this value (it is a secret) in packages/backend/.env or the deployment secrets:\n',
    )
    console.log(`MFA_ENCRYPTION_KEYS="${value}"`)
    console.log(`\n${note}`)
    console.log('Or run with --write to save it to .env.')
    process.exit(0)
}

writeFileSync(envPath, upsertEnvValues(content, { MFA_ENCRYPTION_KEYS: value }))
console.log(`MFA_ENCRYPTION_KEYS written to ${envPath}. ${note}`)
console.log('Restart the backend to apply it.')
