import { expect, test as base } from '@playwright/test'
import type { APIRequestContext, Browser, BrowserContext, Page, WebSocket } from '@playwright/test'

import { randomUUID } from 'node:crypto'

import { ORIGIN, SMTP_PORT } from './fixtures'
import { MailSink } from './mail-sink'

export interface Account {
    email: string
    password: string
}

/** One inbox for the run: the backend sends here (playwright.live.config.ts). */
export const test = base.extend<object, { sink: MailSink }>({
    sink: [
        // Playwright passes the fixtures first: this one needs none.
        async ({}, use) => {
            const sink = new MailSink()
            await sink.start(SMTP_PORT)
            await use(sink)
            await sink.stop()
        },
        { scope: 'worker' },
    ],
})

export { expect }

let devices = 0

/**
 * A browser of its own: cookies, storage and sessions are shared with no other, and it is its own
 * device for the backend: an address of its own in X-Forwarded-For.
 */
export async function newBrowser(
    browser: Browser,
): Promise<{ context: BrowserContext; page: Page; sockets: WebSocket[] }> {
    devices += 1
    const address = `10.77.${String(Math.floor(devices / 250))}.${String((devices % 250) + 1)}`
    const context = await browser.newContext({
        baseURL: ORIGIN,
        extraHTTPHeaders: { 'x-forwarded-for': address },
    })
    const page = await context.newPage()
    // Every WebSocket the page opens, to see which ones the server ends.
    const sockets: WebSocket[] = []
    page.on('websocket', (socket) => {
        sockets.push(socket)
    })
    return { context, page, sockets }
}

/** The text of the first link in a mail whose path is `path`, as the user would click it. */
export function linkIn(text: string, path: string): string {
    const match = new RegExp(
        `https?://[^\\s"'<>]*${path.replaceAll('/', '\\/')}\\?token=[\\w-]+`,
    ).exec(text)
    if (match === null) throw new Error(`No ${path} link in the mail:\n${text.slice(0, 800)}`)
    return match[0]
}

/**
 * Signs in through the modal, then opens the account page. The modal sends the user there itself,
 * but now and then the page is left on the home page instead (the modal's `close` replaces the
 * route while the sign-in pushes /account; recorded in progress.md for the split of
 * AuthModals.vue). What these specs check is the session, not that navigation, so they do not
 * depend on it.
 */
export async function loginInUi(page: Page, account: Account): Promise<void> {
    await page.goto('/login')
    await page.locator('#login-identifier').fill(account.email)
    await page.locator('#login-password').fill(account.password)
    const signedIn = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/auth/login' &&
            response.request().method() === 'POST',
    )
    await page
        .locator('button.auth-button', { has: page.locator('span', { hasText: 'Sign In' }) })
        .click()
    expect((await signedIn).status()).toBe(200)
    await page.goto('/account')
    await expect(page.getByText(account.email)).toBeVisible()
}

/**
 * What another tab (or a script) of the same browser does: same cookies, its own CSRF token.
 */
export const session = (request: APIRequestContext) => ({
    async token(): Promise<string> {
        const response = await request.get('/api/main/init')
        const body = (await response.json()) as { csrfToken: string }
        return body.csrfToken
    },
    async post(path: string, data: Record<string, unknown>) {
        const token = await this.token()
        return request.post(path, { data, headers: { origin: ORIGIN, 'x-csrf-token': token } })
    },
    /** The e-mail of the signed-in user, or null when the session is not valid. */
    async whoAmI(): Promise<string | null> {
        const response = await request.get('/api/main/init')
        if (response.status() === 401) return null
        const body = (await response.json()) as { user: { email: string } }
        return body.user.email
    },
})

/**
 * The newest mail to `address` that carries a link to `path`, waiting for it: the same address
 * gets a verification mail at registration and a reset mail later, and a test wants one of them.
 */
export async function linkFromMail(
    sink: MailSink,
    address: string,
    path: string,
    timeoutMs = 10_000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        for (const mail of [...sink.mails].reverse()) {
            if (!mail.to.some((to) => to.toLowerCase() === address.toLowerCase())) continue
            try {
                return linkIn(mail.text, path)
            } catch {
                // another kind of mail to the same address
            }
        }
        if (Date.now() > deadline) throw new Error(`No ${path} link mailed to ${address}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
}

export const newAccount = (): Account => ({
    email: `live-${randomUUID().slice(0, 8)}@example.test`,
    password: 'live-e2e-pass-9',
})

/**
 * A registered and verified account, made the way a user does it but through the API of a
 * browser of its own: register, read the mail, confirm the link. Nothing is signed in afterwards.
 */
export async function createVerifiedAccount(browser: Browser, sink: MailSink): Promise<Account> {
    const account = newAccount()
    const { context } = await newBrowser(browser)
    try {
        const tab = session(context.request)
        const registered = await tab.post('/api/auth/register/email', {
            name: 'Live E2E',
            email: account.email,
            password: account.password,
            token: '',
        })
        expect(registered.status()).toBe(200)

        const token = new URL(
            await linkFromMail(sink, account.email, '/verify-email'),
        ).searchParams.get('token')
        const verified = await tab.post('/api/auth/verify-email', { token })
        expect(verified.status()).toBe(200)
    } finally {
        await context.close()
    }
    return account
}
