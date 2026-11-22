import { Result } from 'better-result'

import { userRepository } from '../app/repositories/index.js'
import { normalizeEmail } from '../app/services/auth/auth-normalize.js'
import { systemActor } from '../app/services/audit/audit-actor.js'
import { mfaResetService } from '../app/services/auth/mfa/mfa-reset-service.js'
import { appErrorMessage, appErrorReason } from '../app/services/shared/errors.js'
import { parseUserMfaResetArgs } from './user-mfa-reset-args.js'

export interface UserMfaResetIo {
    print(line: string): void
    printError(line: string): void
}

/**
 * The work of `user:mfa-reset` (feat-247, Р13), apart from the process around it so a test runs it
 * as it is. The way back in for the last administrator: the same service as the admin API, as the
 * `system` actor with source `cli` and the same rules (the account keeps a way to sign in).
 * Returns the exit code.
 */
export async function runUserMfaReset(
    argv: readonly string[],
    io: UserMfaResetIo,
): Promise<number> {
    const { email, reason } = parseUserMfaResetArgs(argv)
    const user = await userRepository.findByEmail(normalizeEmail(email))
    if (user === undefined) {
        io.printError(`No user with the email ${email}.`)
        return 1
    }
    const result = await mfaResetService.reset({
        actor: systemActor('cli'),
        targetUserId: user.id,
        reason,
    })
    if (Result.isError(result)) {
        const why = appErrorReason(result.error)
        io.printError(
            `Refused${why === undefined ? '' : ` (${why})`}: ${appErrorMessage(result.error)}.`,
        )
        return 1
    }
    const { removed } = result.value
    io.print(
        `User ${String(user.id)}: second factors reset (TOTP ${removed.totp ? 'removed' : 'none'}, ` +
            `${String(removed.passkeys)} passkey(s), ${String(removed.recoveryCodes)} recovery code(s)); ` +
            'every session was signed out.',
    )
    return 0
}
