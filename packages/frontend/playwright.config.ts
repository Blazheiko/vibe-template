import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
// The auth specs in e2e/mock/ answer every request themselves (page.route) and need the phone
// steps of the auth modals, whatever packages/frontend/.env says. They get their own build of the
// SPA, with the flag forced and the API base pointing at the page's own origin (a cross-origin
// base from a developer's .env would make the browser enforce CORS on the faked answers).
// Its own port, its own output directory: the dev/preview server of the other projects is not
// touched.
const MOCK_PORT = 4174
const MOCK_ORIGIN = `http://localhost:${String(MOCK_PORT)}`

export default defineConfig({
    testDir: './e2e',
    /* Maximum time one test can run for. */
    timeout: 30 * 1000,
    expect: {
        /**
         * Maximum time expect() should wait for the condition to be met.
         * For example in `await expect(locator).toHaveText();`
         */
        timeout: 5000,
    },
    /* Fail the build on CI if you accidentally left test.only in the source code. */
    forbidOnly: !!process.env.CI,
    /* Retry on CI only */
    retries: process.env.CI ? 2 : 0,
    /* Opt out of parallel tests on CI. */
    workers: process.env.CI ? 1 : undefined,
    /* Reporter to use. See https://playwright.dev/docs/test-reporters */
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',
    /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
    use: {
        /* Maximum time each action such as `click()` can take. Defaults to 0 (no limit). */
        actionTimeout: 0,
        /* Base URL to use in actions like `await page.goto('/')`. */
        baseURL: process.env.CI ? 'http://localhost:4173' : 'http://localhost:5173',

        /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
        trace: 'on-first-retry',

        /* Only on CI systems run the tests headless */
        headless: !!process.env.CI,
    },

    /* Configure projects for major browsers */
    projects: [
        {
            name: 'chromium',
            testIgnore: 'mock/**',
            use: {
                ...devices['Desktop Chrome'],
            },
        },
        {
            name: 'firefox',
            testIgnore: 'mock/**',
            use: {
                ...devices['Desktop Firefox'],
            },
        },
        {
            name: 'webkit',
            testIgnore: 'mock/**',
            use: {
                ...devices['Desktop Safari'],
            },
        },

        {
            name: 'Mobile Safari',
            testIgnore: 'mock/**',
            use: {
                ...devices['iPhone 12'],
            },
        },

        // Auth UI states against faked API answers (feat-069, G2). One browser: the point is
        // what the modals do, not how three engines render them.
        {
            name: 'mock',
            testMatch: 'mock/**/*.spec.ts',
            // Everything is faked and local: a step that takes seconds is stuck, not slow.
            timeout: 15 * 1000,
            use: {
                ...devices['Desktop Chrome'],
                baseURL: MOCK_ORIGIN,
                actionTimeout: 5 * 1000,
            },
        },

        /* Test against branded browsers. */
        // {
        //   name: 'Microsoft Edge',
        //   use: {
        //     channel: 'msedge',
        //   },
        // },
        // {
        //   name: 'Google Chrome',
        //   use: {
        //     channel: 'chrome',
        //   },
        // },
    ],

    /* Folder for test artifacts such as screenshots, videos, traces, etc. */
    // outputDir: 'test-results/',

    /* Run your local dev server before starting the tests */
    webServer: [
        {
            /**
             * Use the dev server by default for faster feedback loop.
             * Use the preview server on CI for more realistic testing.
             * Playwright will re-use the local server if there is already a dev-server running.
             */
            command: process.env.CI ? 'pnpm run preview' : 'pnpm run dev',
            port: process.env.CI ? 4173 : 5173,
            reuseExistingServer: !process.env.CI,
        },
        {
            command:
                'pnpm exec vite build --outDir dist-e2e-mock --emptyOutDir && ' +
                `pnpm exec vite preview --outDir dist-e2e-mock --port ${String(MOCK_PORT)} --strictPort`,
            port: MOCK_PORT,
            env: {
                VITE_AUTH_PHONE_ENABLED: 'true',
                VITE_BASE_URL: MOCK_ORIGIN,
                VITE_SENTRY_ENABLED: 'false',
            },
            reuseExistingServer: false,
            timeout: 180 * 1000,
        },
    ],
})
