import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

/**
 * Smoke tests of the built landing on `vite preview` (http://localhost:4174). Build first:
 * `pnpm --filter landing build && pnpm --filter landing test:e2e`. The buttons are checked by
 * their address, the app itself is not started.
 */
const PORT = 4174

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: process.env.CI !== undefined,
    retries: process.env.CI !== undefined ? 1 : 0,
    reporter: process.env.CI !== undefined ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: `http://localhost:${String(PORT)}`,
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        {
            // The prerendered pages work without JavaScript.
            name: 'no-javascript',
            use: { ...devices['Desktop Chrome'], javaScriptEnabled: false },
        },
        { name: 'mobile', use: { ...devices['Pixel 7'] } },
    ],
    webServer: {
        command: `pnpm exec vite preview --port ${String(PORT)} --strictPort`,
        url: `http://localhost:${String(PORT)}/`,
        reuseExistingServer: process.env.CI === undefined,
        timeout: 60_000,
    },
})
