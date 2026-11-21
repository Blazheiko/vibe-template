import { Result } from 'better-result'

import { userRepository } from '../app/repositories/index.js'
import { normalizeEmail } from '../app/services/auth/auth-normalize.js'
import { systemActor } from '../app/services/audit/audit-actor.js'
import { roleAssignmentService } from '../app/services/user/role-assignment-service.js'
import { appErrorMessage, appErrorReason } from '../app/services/shared/errors.js'
import { publishRoleChangedFromCli } from './user-set-role-publish.js'
import { parseUserSetRoleArgs } from './user-set-role-args.js'

export interface UserSetRoleIo {
    print(line: string): void
    printError(line: string): void
}

/**
 * The work of `user:set-role` (feat-240, docs/plan/roles-permissions-plan.md Р7), apart from the
 * process around it so a test runs it as it is. Returns the exit code.
 */
export async function runUserSetRole(argv: readonly string[], io: UserSetRoleIo): Promise<number> {
    const { email, role } = parseUserSetRoleArgs(argv)
    const user = await userRepository.findByEmail(normalizeEmail(email))
    if (user === undefined) {
        io.printError(`No user with the email ${email}.`)
        return 1
    }

    const result = await roleAssignmentService.assign({
        actor: systemActor('cli'),
        targetUserId: user.id,
        role,
    })
    if (Result.isError(result)) {
        const reason = appErrorReason(result.error)
        io.printError(
            `Refused${reason === undefined ? '' : ` (${reason})`}: ${appErrorMessage(result.error)}.`,
        )
        return 1
    }
    if (!result.value.changed) {
        io.print(`User ${String(user.id)} already has the role ${role}.`)
        return 0
    }
    io.print(`User ${String(user.id)}: role ${user.role} -> ${result.value.role}.`)
    await publishRoleChangedFromCli(user.id)
    return 0
}
