import { expect, test, type Page, type Route } from '@playwright/test'

/**
 * feat-278 (T6): how the production build reacts when a lazy page chunk does not load. The
 * About page (/about) is a lazy public route with a link on the home page, so no sign-in is needed.
 *
 * The service worker is blocked here: these scenarios check the app's own recovery, and the
 * worker's requests would bypass `page.route`. The real deploy, build A to build B with an
 * active worker, is e2e-stale-build/ (scripts/stale-build-check.sh).
 */
test.use({ serviceWorkers: 'block' })

const ABOUT_CHUNK = /\/assets\/ManifestoSocial-[\w-]+\.js$/

/** Counts full page loads from now on. */
function countLoads(page: Page): () => number {
    let loads = 0
    page.on('load', () => {
        loads += 1
    })
    return () => loads
}

/**
 * Fails every request for the About chunk until the next page load (the deploy: the old
 * build's file is gone), lets them through after it. Both requests matter: Vite's
 * `modulepreload` of the chunk and the `import()` itself, which fetches it again.
 * Call after the first `goto`.
 */
async function failAboutChunkUntilReload(page: Page, fail: (route: Route) => Promise<void>) {
    // On the navigation request, not on `load`: the new page imports the chunk before `load`.
    let reloaded = false
    page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) reloaded = true
    })
    await page.route(ABOUT_CHUNK, (route) => (reloaded ? route.continue() : fail(route)))
}

const openAbout = (page: Page) => page.locator('a.manifesto-link:visible').click()
const aboutHeading = (page: Page) => page.getByRole('heading', { level: 1, name: 'About' })

test('a missing chunk reloads once, straight to the target page', async ({ page }) => {
    await page.goto('/')
    const loads = countLoads(page)
    await failAboutChunkUntilReload(page, (route) =>
        route.fulfill({ status: 404, body: 'Not found' }),
    )

    await openAbout(page)

    await expect(aboutHeading(page)).toBeVisible()
    await expect(page).toHaveURL(/\/about$/)
    // The new page may render before its `load` event.
    await expect.poll(loads).toBe(1)
    await page.waitForTimeout(500)
    expect(loads()).toBe(1)
})

test('a transient network failure while online recovers with one reload', async ({ page }) => {
    await page.goto('/')
    const loads = countLoads(page)
    await failAboutChunkUntilReload(page, (route) => route.abort('failed'))

    await openAbout(page)

    await expect(aboutHeading(page)).toBeVisible()
    await expect(page).toHaveURL(/\/about$/)
    // The new page may render before its `load` event.
    await expect.poll(loads).toBe(1)
    await page.waitForTimeout(500)
    expect(loads()).toBe(1)
})

test('a chunk that keeps failing gives up with a notice instead of a reload loop', async ({
    page,
}) => {
    await page.route(ABOUT_CHUNK, (route) => route.fulfill({ status: 404, body: 'Not found' }))
    await page.goto('/')
    const loads = countLoads(page)

    await openAbout(page)

    await expect(page.getByRole('alert')).toContainText('could not be loaded')
    await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible()
    // The one reload happened and the second failure stopped there.
    await expect(page).toHaveURL(/\/about$/)
    await page.waitForTimeout(1000)
    expect(loads()).toBe(1)
})

test('offline: a notice, no reload; back online: the target page opens', async ({
    page,
    context,
}) => {
    await page.goto('/')
    const loads = countLoads(page)
    await context.setOffline(true)

    await openAbout(page)

    await expect(page.getByRole('alert')).toContainText('No network connection')
    expect(loads()).toBe(0)

    await context.setOffline(false)
    await expect(aboutHeading(page)).toBeVisible()
    await expect(page).toHaveURL(/\/about$/)
    // The new page may render before its `load` event.
    await expect.poll(loads).toBe(1)
    await page.waitForTimeout(500)
    expect(loads()).toBe(1)
})
