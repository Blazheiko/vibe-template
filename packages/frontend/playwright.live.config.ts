import { createECDH } from 'node:crypto'
import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

import { DB_NAME, ORIGIN, PORT, SMTP_PORT, USER_1, USER_2 } from './e2e-live/fixtures'

/**
 * The SPA against the real backend, PostgreSQL, Redis and a mail sink (feat-069, G3): what the
 * mocks of e2e/mock cannot show — that a session is really revoked in another browser. Run via
 * `pnpm --filter frontend test:e2e:live`, which builds once (the SPA without phone auth, served
 * by the backend). Requires PostgreSQL (with pgvector) and Redis as in packages/backend/.env;
 * the run uses a database and a Redis key prefix of its own.
 */

// A prefix per run: the throttle counters of an earlier run cannot leak into this one.
const REDIS_PREFIX = `e2e-live-${String(Date.now())}:`

// A VAPID key pair per run (push-account-switch.spec.ts): the SPA asks the backend for the
// public key before it subscribes. Nothing is sent with it: the specs replace PushManager.
const vapid = createECDH('prime256v1')
vapid.generateKeys()

export default defineConfig({
    testDir: './e2e-live',
    // feat-248: run only under playwright.live-passkey.config.ts (MFA_STAFF_FACTOR=passkey and a
    // step-up window of 30 s).
    testIgnore: ['staff-passkey-mode.spec.ts', 'reauth-step-up.spec.ts'],
    timeout: 60 * 1000,
    expect: { timeout: 10 * 1000 },
    forbidOnly: !!process.env.CI,
    // One worker: the mail sink is one inbox and the tests share one backend.
    workers: 1,
    retries: 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    outputDir: 'test-results/live',
    use: {
        ...devices['Desktop Chrome'],
        baseURL: ORIGIN,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    webServer: {
        // The webServer starts before any globalSetup would run, so the database is made here:
        // created if missing, migrated, two verified accounts seeded (idempotent), then the
        // backend. A rerun starts from the same place.
        command:
            'pnpm --filter backend db:create && pnpm --filter backend db:migrate && ' +
            'pnpm --filter backend db:seed --demo && ../../scripts/prod-local.sh',
        env: {
            SEED_USER_EMAIL: USER_1.email,
            SEED_USER_PASSWORD: USER_1.password,
            SEED_ADMIN_EMAIL: USER_2.email,
            SEED_ADMIN_PASSWORD: USER_2.password,
            // feat-247: the admin passes the staff MFA rule with an app of a known key.
            SEED_ADMIN_TOTP_SECRET: USER_2.totpSecret,
            PROD_LOCAL_SKIP_BUILD: 'true',
            PORT: String(PORT),
            PGSQL_DB_NAME: DB_NAME,
            REDIS_PREFIX,
            CSRF_ENFORCE: 'true',
            CSRF_STRICT_ORIGIN: 'true',
            CSRF_ALLOWED_ORIGINS: ORIGIN,
            // Mail goes to the sink in e2e-live/mail-sink.ts: plain SMTP on localhost.
            SMTP_ENABLED: 'true',
            SMTP_HOST: '127.0.0.1',
            SMTP_PORT: String(SMTP_PORT),
            SMTP_SECURE: 'false',
            SMTP_REQUIRE_TLS: 'false',
            SMTP_IGNORE_TLS: 'true',
            SMTP_USER: '',
            SMTP_PASSWORD: '',
            SMTP_FROM_EMAIL: 'noreply@example.test',
            SMTP_FROM_NAME: 'Live E2E',
            VAPID_PUBLIC_KEY: vapid.getPublicKey('base64url'),
            VAPID_PRIVATE_KEY: vapid.getPrivateKey('base64url'),
            VAPID_SUBJECT: 'mailto:live-e2e@example.test',
            // Every browser of a scenario is its own device: it presents its own address in
            // X-Forwarded-For (e2e-live/support.ts), which the backend trusts from localhost only.
            // Without it all of them are 127.0.0.1 and the 10-a-minute limit of the auth routes
            // (http-routes.ts) stops the run.
            TRUST_PROXY: 'true',
            TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
            // The scenarios also load the SPA many times.
            HTTP_GLOBAL_RATE_LIMIT_MAX: '1000000',
            AUTH_LOGIN_MAX_ATTEMPTS_PER_IP: '10000',
            // feat-247: the seeded admin signs in with its app's code in many scenarios of a run;
            // every code spends one attempt of its per-user budget (10 in 15 minutes).
            AUTH_MFA_VERIFY_MAX_ATTEMPTS_PER_USER: '10000',
            // account-profile.spec.ts changes the two seeded profiles many times in one run.
            AUTH_PROFILE_MAX_UPDATES_PER_USER_PER_10_MIN: '10000',
            // Not left to a developer's .env: the production default, and the SPA is built without phone.
            AUTH_STRICT_REGISTRATION: 'true',
            AUTH_PHONE_ENABLED: 'false',
        },
        url: `${ORIGIN}/`,
        // Never reuse: a server started with other settings would hide failures.
        reuseExistingServer: false,
        timeout: 90 * 1000,
    },
})
