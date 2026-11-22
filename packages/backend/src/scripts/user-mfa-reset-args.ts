// What `user:mfa-reset` is asked to do (feat-247, docs/plan/passkeys-mfa-plan.md Р13).

export interface UserMfaResetArgs {
    email: string
    reason: string
}

export const USAGE =
    'Usage: pnpm --filter backend user:mfa-reset --email <email> --reason "<why the factors go>"'

export function parseUserMfaResetArgs(args: readonly string[]): UserMfaResetArgs {
    let email: string | undefined
    let reason: string | undefined
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]
        const value = args[index + 1]
        if (arg === '--email' || arg === '--reason') {
            if (value === undefined || value.startsWith('--')) {
                throw new Error(`${arg} needs a value. ${USAGE}`)
            }
            if (arg === '--email') {
                if (email !== undefined) throw new Error(`--email is given twice. ${USAGE}`)
                email = value
            } else {
                if (reason !== undefined) throw new Error(`--reason is given twice. ${USAGE}`)
                reason = value
            }
            index += 1
        } else {
            throw new Error(`Unknown argument "${String(arg)}". ${USAGE}`)
        }
    }
    if (email === undefined || email.trim() === '') throw new Error(`No --email given. ${USAGE}`)
    const trimmed = reason?.trim() ?? ''
    if (trimmed.length < 3 || trimmed.length > 200) {
        throw new Error(`--reason must be 3 to 200 characters. ${USAGE}`)
    }
    return { email, reason: trimmed }
}
