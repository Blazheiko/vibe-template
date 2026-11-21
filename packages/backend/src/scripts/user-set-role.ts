import 'dotenv/config'

import { pool } from '../database/db.js'
import redis, { redisHealth } from '../database/redis.js'
import { runUserSetRole } from './user-set-role-cli.js'

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
runUserSetRole(process.argv.slice(2), {
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
