import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { expect, test, type Page } from '@playwright/test'

/**
 * feat-278 (T6): a tab of build A survives a deploy of build B. Started by
 * scripts/stale-build-check.sh, which builds A and B (B marks the About page) and passes their
 * directories. The backend indexes its static files at start, so the deploy is a restart on B.
 *
 * Expected: the click on About in the tab of A loads B's page with at most one reload, B's
 * service worker takes over, and nothing loops.
 */

const ROOT = process.env.STALE_ROOT ?? ''
const A_DIR = process.env.STALE_A_DIR ?? ''
const B_DIR = process.env.STALE_B_DIR ?? ''
const PORT = process.env.PORT ?? '3300'
const ORIGIN = `http://localhost:${PORT}`
const PUBLIC = path.join(ROOT, 'packages/backend/public')

function deploy(dir: string): void {
    rmSync(PUBLIC, { recursive: true, force: true })
    cpSync(dir, PUBLIC, { recursive: true })
}

async function startServer(): Promise<ChildProcess> {
    const server = spawn(path.join(ROOT, 'scripts/prod-local.sh'), {
        cwd: ROOT,
        env: { ...process.env, PROD_LOCAL_SKIP_BUILD: 'true', PORT },
        detached: true,
        stdio: 'inherit',
    })
    for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
            if ((await fetch(`${ORIGIN}/`)).ok) return server
        } catch {
            // Not listening yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('the backend did not start')
}

async function stopServer(server: ChildProcess): Promise<void> {
    if (server.exitCode !== null || server.pid === undefined) return
    const exited = new Promise((resolve) => server.once('exit', resolve))
    process.kill(-server.pid, 'SIGTERM')
    await exited
}

const cacheNames = (page: Page) => page.evaluate(() => caches.keys())

test.skip(ROOT === '' || A_DIR === '' || B_DIR === '', 'run scripts/stale-build-check.sh')

test('a tab of build A opens a lazy page after a deploy of build B', async ({ page }) => {
    deploy(A_DIR)
    let server = await startServer()
    try {
        await page.goto('/')
        await page.evaluate(async () => {
            await navigator.serviceWorker.ready
        })
        await page.reload()
        await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
        const cachesOfA = await cacheNames(page)

        await stopServer(server)
        deploy(B_DIR)
        server = await startServer()

        let loads = 0
        page.on('load', () => {
            loads += 1
        })
        await page.locator('a.manifesto-link:visible').click()

        await expect(page).toHaveURL(/\/about$/)
        await expect(page.locator('[data-stale-build="B"]')).toHaveCount(1)
        await expect.poll(() => loads).toBe(1)
        // B's worker took over: A's caches are gone.
        await expect
            .poll(async () => (await cacheNames(page)).some((name) => cachesOfA.includes(name)))
            .toBe(false)
        await page.waitForTimeout(2000)
        expect(loads).toBe(1)
        await expect(page.getByRole('alert')).toHaveCount(0)
    } finally {
        await stopServer(server)
    }
})
