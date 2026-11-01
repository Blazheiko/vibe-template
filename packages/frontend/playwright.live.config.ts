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

export default defineConfig({
    testDir: './e2e-live',
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
            // Every browser of a scenario is its own device: it presents its own address in
            // X-Forwarded-For (e2e-live/support.ts), which the backend trusts from localhost only.
            // Without it all of them are 127.0.0.1 and the 10-a-minute limit of the auth routes
            // (http-routes.ts) stops the run.
            TRUST_PROXY: 'true',
            TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
            // The scenarios also load the SPA many times.
            HTTP_GLOBAL_RATE_LIMIT_MAX: '1000000',
            AUTH_LOGIN_MAX_ATTEMPTS_PER_IP: '10000',
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
