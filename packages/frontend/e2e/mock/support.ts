import { expect, test as base } from '@playwright/test'
import type { Locator, Page, Request, Route } from '@playwright/test'

// feat-069 (G2): the auth modals against faked API answers. Nothing here reaches a backend:
// every request the modals make is answered by a `page.route` handler of the test, and a request
// no test answered fails the test. The specs pin what AuthModals.vue does *today*, so that the
// split of that file (J) can be checked against them; a behaviour that looks like a bug is
// recorded as it is and said so in the spec.

export const CSRF_TOKEN = 'a'.repeat(43)

export interface Recorded {
    method: string
    path: string
    body: unknown
}

export interface Api {
    /** Every request to a path that was answered through `answer`, in order. */
    readonly calls: Recorded[]
    /** The calls to one path, as `/api/<path>`. */
    callsTo: (path: string) => Recorded[]
    /**
     * Answer `/api/<path>` with a status and a JSON body, optionally after a delay and with a
     * hook that runs when the request arrives.
     */
    answer: (
        path: string,
        status: number,
        body: unknown,
        options?: { delayMs?: number; onRequest?: () => void },
    ) => Promise<void>
    /** From now on `main/init` says this user is signed in (null: nobody). */
    setSession: (user: object | null) => void
    /** Let requests nobody answered through with an empty 200 instead of failing the test. */
    ignoreOtherRequests: () => void
}

const recordOf = (request: Request): Recorded => {
    const raw = request.postData()
    let body: unknown = undefined
    if (raw !== null) {
        try {
            body = JSON.parse(raw)
        } catch {
            body = raw
        }
    }
    return { method: request.method(), path: new URL(request.url()).pathname, body }
}

/**
 * An anonymous visitor: `main/init` says "nobody is signed in" (401) and hands out the CSRF
 * token. Everything else under /api is the test's to answer; whatever it leaves unanswered is
 * collected, answered with a refused connection, and fails the test when it ends.
 */
export const test = base.extend<{ api: Api }>({
    api: async ({ page }, use) => {
        const calls: Recorded[] = []
        const unanswered: string[] = []
        let session: object | null = null
        let lenient = false

        // Playwright runs the handler registered LAST first: the catch-all goes in first, so it
        // only sees what no other handler took (`route.fallback()` is not needed).
        await page.route('**/api/**', async (route: Route) => {
            if (lenient) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ status: 'success' }),
                })
                return
            }
            unanswered.push(
                `${route.request().method()} ${new URL(route.request().url()).pathname}`,
            )
            await route.abort('connectionrefused')
        })
        await page.route('**/api/main/init', async (route: Route) => {
            if (session !== null) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        status: 'ok',
                        user: session,
                        wsUrl: 'ws://127.0.0.1:65535',
                        wsToken: 'e2eWsToken000001',
                        csrfToken: CSRF_TOKEN,
                        storage: {},
                    }),
                })
                return
            }
            await route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 'error',
                    code: 'unauthorized',
                    message: 'Unauthorized',
                    csrfToken: CSRF_TOKEN,
                }),
            })
        })
        // Which social buttons the page shows: none.
        await page.route('**/api/auth/oauth/providers', async (route: Route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ status: 'success', providers: [] }),
            })
        })

        await use({
            calls,
            setSession: (user) => {
                session = user
            },
            ignoreOtherRequests: () => {
                lenient = true
            },
            callsTo: (path) => calls.filter((call) => call.path === `/api/${path}`),
            answer: async (path, status, body, options = {}) => {
                await page.route(`**/api/${path}`, async (route: Route) => {
                    calls.push(recordOf(route.request()))
                    options.onRequest?.()
                    if (options.delayMs !== undefined) {
                        await new Promise((resolve) => setTimeout(resolve, options.delayMs))
                    }
                    await route.fulfill({
                        status,
                        contentType: 'application/json',
                        body: JSON.stringify(body),
                    })
                })
            },
        })

        expect(unanswered, 'requests no test answered').toEqual([])
    },
})

export { expect }

export const loginModal = (page: Page): Locator => page.locator('.modal-overlay').nth(0)
export const registerModal = (page: Page): Locator => page.locator('.modal-overlay').nth(1)

export async function openLogin(page: Page): Promise<Locator> {
    await page.goto('/')
    await page.getByRole('button', { name: 'Sign In' }).first().click()
    const modal = loginModal(page)
    await expect(modal.locator('#login-identifier')).toBeVisible()
    return modal
}

export async function openRegister(page: Page): Promise<Locator> {
    await page.goto('/')
    await page.getByRole('button', { name: 'Create Account' }).first().click()
    const modal = registerModal(page)
    await expect(modal.getByRole('button', { name: 'Continue with email' })).toBeVisible()
    return modal
}

/** The error shown above the form of the current step. */
export const formError = (modal: Locator): Locator => modal.locator('.form-error')
/** A field-level error, by the id of its input. */
export const fieldError = (modal: Locator, id: string): Locator =>
    modal
        .locator(`#${id}`)
        .locator('xpath=following-sibling::div[contains(@class,"error-message")]')

/** A signed-in answer of an auth endpoint, as the server sends it. */
export const SIGNED_IN = {
    status: 'success',
    user: { id: '1', name: 'Jane', email: 'jane@example.com', role: 'user' },
    wsUrl: 'ws://127.0.0.1:65535',
    wsToken: 'e2eWsToken000001',
    csrfToken: CSRF_TOKEN,
}

/**
 * A real mouse click on the place of a (disabled) control. `locator.click()` waits for a disabled
 * control to become enabled and `{ force: true }` skips the checks; this one is what a user's
 * second click does: the pointer lands, the browser delivers nothing.
 */
export async function clickWhereItIs(page: Page, locator: Locator): Promise<void> {
    const box = await locator.boundingBox()
    expect(box, 'the control has a position').not.toBeNull()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}
