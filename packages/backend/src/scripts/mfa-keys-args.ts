// What `mfa:keys` is asked to do (feat-260).

export type MfaKeysMode = 'new' | 'rotate' | 'check'

export interface MfaKeysArgs {
    mode: MfaKeysMode
    /** Save the result to packages/backend/.env instead of printing it. */
    write: boolean
}

export const USAGE = 'Usage: pnpm --filter backend mfa:keys [--rotate] [--write] | --check'

export function parseMfaKeysArgs(args: readonly string[]): MfaKeysArgs {
    const seen = new Set<string>()
    for (const arg of args) {
        if (arg !== '--rotate' && arg !== '--write' && arg !== '--check') {
            throw new Error(`Unknown argument "${arg}". ${USAGE}`)
        }
        if (seen.has(arg)) throw new Error(`${arg} is given twice. ${USAGE}`)
        seen.add(arg)
    }
    if (seen.has('--check') && seen.size > 1) {
        throw new Error(`--check takes no other argument. ${USAGE}`)
    }
    const mode: MfaKeysMode = seen.has('--check')
        ? 'check'
        : seen.has('--rotate')
          ? 'rotate'
          : 'new'
    return { mode, write: seen.has('--write') }
}
