import 'dotenv/config'

import { pool } from '../database/db.js'
import redis, { redisHealth } from '../database/redis.js'
import { runUserMfaReset } from './user-mfa-reset-cli.js'

// Resets the second factors of a user (feat-247, docs/plan/passkeys-mfa-plan.md Р13):
//
//   pnpm --filter backend user:mfa-reset --email <email> --reason "<why>"
//   make user-mfa-reset ARGS='--email <email> --reason "<why>"'
//
// The emergency exit when the last administrator lost every factor and recovery code. Runs the
// same service as the admin API as the `system` actor with source `cli`; the account keeps its
// password, and a reset that would leave no way to sign in is refused.
runUserMfaReset(process.argv.slice(2), {
    print: (line) => {
        console.log(line)
    },
    printError: (line) => {
        console.error(line)
    },
})
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
