import { resolve } from 'node:path'
import process from 'node:process'

import { runMfaKeys } from './mfa-keys-run.js'

// feat-260. Usage:
//   pnpm --filter backend mfa:keys                    print a new value (one key, k1)
//   pnpm --filter backend mfa:keys --write            save it to packages/backend/.env
//   pnpm --filter backend mfa:keys --rotate           print the current value with a new key first
//   pnpm --filter backend mfa:keys --rotate --write   rotate the value in packages/backend/.env
//   pnpm --filter backend mfa:keys --check            validate the current value
//
// The current value is the one the server reads: MFA_ENCRYPTION_KEYS of the shell when it is set
// (even empty), else packages/backend/.env read with dotenv; --write refuses while the shell sets
// it. Keep every old key: a TOTP secret sealed with a dropped key can no longer be read. The
// built image runs the compiled script: `node dist/scripts/mfa-keys.js` (no .env there; print or
// --check only).

const run = runMfaKeys({
    args: process.argv.slice(2),
    shell: process.env,
    envPath: resolve(process.cwd(), '.env'),
})
for (const line of run.out) console.log(line)
for (const line of run.err) console.error(line)
process.exit(run.code)
