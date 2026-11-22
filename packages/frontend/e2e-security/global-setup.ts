import { execFileSync } from 'node:child_process'

import { USER_1, USER_2 } from './fixtures'

/**
 * Two verified accounts for the CSRF scenarios. The seed is idempotent: existing
 * accounts are left as they are.
 */
export default function globalSetup(): void {
    execFileSync('pnpm', ['--filter', 'backend', 'db:seed', '--demo'], {
        stdio: 'inherit',
        env: {
            ...process.env,
            SEED_USER_EMAIL: USER_1.email,
            SEED_USER_PASSWORD: USER_1.password,
            SEED_ADMIN_EMAIL: USER_2.email,
            SEED_ADMIN_PASSWORD: USER_2.password,
            SEED_ADMIN_TOTP_SECRET: USER_2.totpSecret,
        },
    })
}
