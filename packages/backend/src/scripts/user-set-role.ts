import 'dotenv/config'

import { Result } from 'better-result'

import { pool } from '../database/db.js'
import redis, { redisHealth } from '../database/redis.js'
import { userRepository } from '../app/repositories/index.js'
import { normalizeEmail } from '../app/services/auth/auth-normalize.js'
import { systemActor } from '../app/services/audit/audit-actor.js'
import { roleAssignmentService } from '../app/services/user/role-assignment-service.js'
import { appErrorMessage, appErrorReason } from '../app/services/shared/errors.js'
import { publishRoleChangedFromCli } from './user-set-role-publish.js'
import { parseUserSetRoleArgs } from './user-set-role-args.js'

// Gives a user a role (feat-240, docs/plan/roles-permissions-plan.md Р7):
//
//   pnpm --filter backend user:set-role --email <email> --role <role>
//   make user-role ARGS="--email <email> --role <role>"
//
// The way to give the first staff roles and to recover when no administrator is left. Runs the
// same service as the admin API, as the `system` actor with source `cli`: the delegation rules do
// not apply (access to the server is access to everything), the verified-email and last-admin
// rules do. After the commit it signals the running instances, which re-read the role of the
// user's open connections; if that fails, their periodic pass applies it.
async function main(): Promise<number> {
    const { email, role } = parseUserSetRoleArgs(process.argv.slice(2))
    const user = await userRepository.findByEmail(normalizeEmail(email))
    if (user === undefined) {
        console.error(`No user with the email ${email}.`)
        return 1
    }

    const result = await roleAssignmentService.assign({
        actor: systemActor('cli'),
        targetUserId: user.id,
        role,
    })
    if (Result.isError(result)) {
        const reason = appErrorReason(result.error)
        console.error(
            `Refused${reason === undefined ? '' : ` (${reason})`}: ${appErrorMessage(result.error)}.`,
        )
        return 1
    }
    if (!result.value.changed) {
        console.log(`User ${String(user.id)} already has the role ${role}.`)
        return 0
    }
    console.log(`User ${String(user.id)}: role ${user.role} -> ${result.value.role}.`)
    await publishRoleChangedFromCli(user.id)
    return 0
}

main()
    .then((code) => {
        process.exitCode = code
    })
    .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : err)
        process.exitCode = 1
    })
    .finally(async () => {
        redisHealth.stop()
        await Promise.allSettled([pool.end(), redis.quit()])
        // quit() is refused while the client is still connecting (no offline queue).
        redis.disconnect()
    })
