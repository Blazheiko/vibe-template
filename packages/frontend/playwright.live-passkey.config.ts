import { defineConfig } from '@playwright/test'

import { DB_NAME_PASSKEY, REAUTH_WINDOW_SECONDS_SHORT } from './e2e-live/fixtures'
import live from './playwright.live.config'

/**
 * feat-248 (docs/plan/passkeys-mfa-plan.md, Р10, Д11): the live run with MFA_STAFF_FACTOR=passkey.
 * The mode is a setting of the whole backend, and the other live specs sign the seeded admin in
 * with its authenticator app, so this spec gets a backend of its own: the same build and port,
 * started after the main run (`test:e2e:live` runs both configs in turn), with a database and a
 * Redis key prefix of its own.
 *
 * The same backend also has the shortest step-up window (AUTH_REAUTH_WINDOW_SECONDS=30, tasks M13,
 * P5): reauth-step-up.spec.ts lets the proof of a sign-in age out and passes ReauthDialog with the
 * app's code and with a passkey. Those scenarios use ordinary accounts (no staff role), so the
 * passkey mode does not touch them; the main run keeps the default window of 300 s, which its
 * specs rely on (a sign-in a moment ago is a fresh proof). The staff spec here acts right after
 * its sign-in, well inside 30 s.
 */
const server = live.webServer
if (server === undefined || Array.isArray(server)) {
    throw new Error('playwright.live.config.ts must define one webServer')
}

export default defineConfig({
    ...live,
    testIgnore: undefined,
    testMatch: ['staff-passkey-mode.spec.ts', 'reauth-step-up.spec.ts'],
    outputDir: 'test-results/live-passkey',
    webServer: {
        ...server,
        env: {
            ...server.env,
            PGSQL_DB_NAME: DB_NAME_PASSKEY,
            REDIS_PREFIX: `e2e-live-passkey-${String(Date.now())}:`,
            MFA_STAFF_FACTOR: 'passkey',
            AUTH_REAUTH_WINDOW_SECONDS: String(REAUTH_WINDOW_SECONDS_SHORT),
        },
    },
})
