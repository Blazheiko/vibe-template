import { defineConfig } from '@playwright/test'

import { DB_NAME_PASSKEY } from './e2e-live/fixtures'
import live from './playwright.live.config'

/**
 * feat-248 (docs/plan/passkeys-mfa-plan.md, Р10, Д11): the live run with MFA_STAFF_FACTOR=passkey.
 * The mode is a setting of the whole backend, and the other live specs sign the seeded admin in
 * with its authenticator app, so this spec gets a backend of its own: the same build and port,
 * started after the main run (`test:e2e:live` runs both configs in turn), with a database and a
 * Redis key prefix of its own.
 */
const server = live.webServer
if (server === undefined || Array.isArray(server)) {
    throw new Error('playwright.live.config.ts must define one webServer')
}

export default defineConfig({
    ...live,
    testIgnore: undefined,
    testMatch: 'staff-passkey-mode.spec.ts',
    outputDir: 'test-results/live-passkey',
    webServer: {
        ...server,
        env: {
            ...server.env,
            PGSQL_DB_NAME: DB_NAME_PASSKEY,
            REDIS_PREFIX: `e2e-live-passkey-${String(Date.now())}:`,
            MFA_STAFF_FACTOR: 'passkey',
        },
    },
})
