import { existsSync, readFileSync } from 'node:fs'

import { parseMfaKeysArgs } from './mfa-keys-args.js'
import { readEnvKey, setEnvKey, updateFileAtomically } from './mfa-keys-env.js'
import { checkMfaKeys, newMfaKeys, rotateMfaKeys, type PlannedKeys } from './mfa-keys-list.js'

// feat-260: what `mfa:keys` does, apart from the process (mfa-keys.ts). The current value is
// the one the server would read: MFA_ENCRYPTION_KEYS of the shell when it is set (even empty,
// dotenv never overrides it), else the .env file read with dotenv.

const KEY = 'MFA_ENCRYPTION_KEYS'

export interface MfaKeysRun {
    code: 0 | 1
    out: string[]
    err: string[]
}

export interface MfaKeysInput {
    args: readonly string[]
    /** The process environment: a key that is set, even to '', wins over .env. */
    shell: Readonly<Record<string, string | undefined>>
    envPath: string
}

const failed = (message: string): MfaKeysRun => ({ code: 1, out: [], err: [message] })

export function runMfaKeys(input: MfaKeysInput): MfaKeysRun {
    let args
    try {
        args = parseMfaKeysArgs(input.args)
    } catch (err) {
        return failed(err instanceof Error ? err.message : String(err))
    }
    const shellKeys = input.shell[KEY]
    const shellAppKey = input.shell['APP_KEY']

    if (args.write) {
        if (shellKeys !== undefined) {
            return failed(
                `${KEY} is set in the shell, and the server reads it instead of ${input.envPath}; ` +
                    'unset it, or run without --write',
            )
        }
        try {
            return updateFileAtomically(input.envPath, (content) => {
                const current = readEnvKey(content, KEY)
                let planned: PlannedKeys
                if (args.mode === 'rotate') {
                    planned = rotateMfaKeys(current)
                } else if (current !== '') {
                    planned = {
                        ok: false,
                        error:
                            `${KEY} is already set. Replacing it makes every TOTP factor ` +
                            'unreadable; run with --rotate to add a key and keep the current ones',
                    }
                } else {
                    planned = newMfaKeys({
                        keepDevFrom: shellAppKey ?? readEnvKey(content, 'APP_KEY'),
                    })
                }
                if (!planned.ok) {
                    return { content: null, result: failed(`${input.envPath}: ${planned.error}`) }
                }
                const next = setEnvKey(content, KEY, planned.value)
                if (!next.ok) {
                    return { content: null, result: failed(`${input.envPath}: ${next.error}`) }
                }
                return {
                    content: next.content,
                    result: {
                        code: 0,
                        out: [
                            `${KEY} written to ${input.envPath}. ${planned.note}`,
                            'Restart the backend to apply it.',
                        ],
                        err: [],
                    },
                }
            })
        } catch (err) {
            return failed(err instanceof Error ? err.message : String(err))
        }
    }

    const content = existsSync(input.envPath) ? readFileSync(input.envPath, 'utf8') : ''
    const fromShell = shellKeys !== undefined
    const current = fromShell ? shellKeys : readEnvKey(content, KEY)
    const source = fromShell ? `${KEY} of the shell` : input.envPath
    const appKey = shellAppKey ?? readEnvKey(content, 'APP_KEY')

    if (args.mode === 'check') {
        const checked = checkMfaKeys(current)
        if (!checked.ok) {
            const derived =
                current.trim() === '' && appKey !== ''
                    ? ' (outside production the server derives the "dev" key from APP_KEY instead)'
                    : ''
            return failed(`${source}: ${checked.error}${derived}`)
        }
        const [writer, ...readers] = checked.ids
        return {
            code: 0,
            out: [
                `${source}: valid, ${String(checked.ids.length)} key(s).`,
                `New TOTP secrets are encrypted with "${String(writer)}".`,
                ...(readers.length > 0 ? [`Also read: ${readers.join(', ')}.`] : []),
            ],
            err: [],
        }
    }

    const planned = args.mode === 'rotate' ? rotateMfaKeys(current) : newMfaKeys()
    if (!planned.ok) {
        const hint = args.mode === 'rotate' ? ' Run without --rotate for a first key.' : ''
        return failed(`${source}: ${planned.error}.${hint}`)
    }
    const warnings: string[] = []
    if (args.mode === 'new' && current.trim() !== '') {
        warnings.push(
            `${source} already has ${KEY}: replacing it makes every TOTP factor unreadable; ` +
                'use --rotate to add a key.',
        )
    }
    if (args.mode === 'new' && current.trim() === '' && appKey !== '') {
        warnings.push(
            `A server that ran here without ${KEY} sealed TOTP secrets with the "dev" key derived ` +
                'from APP_KEY. This value does not keep it; run with --write to keep it as a ' +
                'reading key.',
        )
    }
    return {
        code: 0,
        out: [
            'Set this value (it is a secret) in packages/backend/.env or the deployment secrets:',
            '',
            `${KEY}="${planned.value}"`,
            '',
            planned.note,
            'Or run with --write to save it to .env.',
        ],
        err: warnings,
    }
}
