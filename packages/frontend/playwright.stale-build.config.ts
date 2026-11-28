import { defineConfig, devices } from '@playwright/test'

/**
 * feat-278 (T6): a deploy from build A to build B under an open tab with an active service
 * worker. The spec starts and restarts the backend itself (scripts/prod-local.sh), so there is
 * no webServer here. Run through scripts/stale-build-check.sh, which builds A and B.
 */
export default defineConfig({
    testDir: './e2e-stale-build',
    timeout: 120 * 1000,
    workers: 1,
    reporter: 'list',
    outputDir: 'test-results/stale-build',
    use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${process.env.PORT ?? '3300'}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
})
