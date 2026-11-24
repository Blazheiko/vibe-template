import process from 'node:process'
import { defineConfig } from '@playwright/test'

import { DB_NAME_PREFIX } from './e2e-live/fixtures'
import live from './playwright.live.config'

/**
 * feat-257 (docs/plan/mfa-review-fixes-7-plan.md, item 2): the MFA continuation against a backend
 * and a build with another API_PATH_PREFIX. The prefix is compiled into the SPA, so
 * `test:e2e:live` builds again with it after the other live runs and starts this one last, with a
 * database and a Redis key prefix of its own. The ticket cookie and its binding cookie have
 * Path=/: a path of the API (`/auth`) would miss `/v2/api/auth`.
 */
const PREFIX = 'v2/api'
// The specs read it (e2e-live/fixtures.ts); the workers load this config too.
process.env.E2E_API_PREFIX = PREFIX

const server = live.webServer
if (server === undefined || Array.isArray(server)) {
    throw new Error('playwright.live.config.ts must define one webServer')
}

export default defineConfig({
    ...live,
    testIgnore: undefined,
    testMatch: ['mfa-continuation.spec.ts'],
    outputDir: 'test-results/live-prefix',
    webServer: {
        ...server,
        env: {
            ...server.env,
            API_PATH_PREFIX: PREFIX,
            PGSQL_DB_NAME: DB_NAME_PREFIX,
            REDIS_PREFIX: `e2e-live-prefix-${String(Date.now())}:`,
            GOOGLE_REDIRECT_URI: `${String(live.use?.baseURL)}/${PREFIX}/auth/oauth/google/callback`,
        },
    },
})
