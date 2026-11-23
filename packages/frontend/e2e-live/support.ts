import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test as base } from '@playwright/test'
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test'

import { randomUUID } from 'node:crypto'

import { ORIGIN, SMTP_PORT } from './fixtures'
import { MailSink } from './mail-sink'
import { stepNow, totpAt } from './totp'

export { totpAt }

export interface Account {
    email: string
    password: string
    /** feat-247: the key of the account's authenticator app, when it has one (base32). */
    totpSecret?: string
}

/**
 * The last step spent per key, kept in a file: the server accepts every step once (replay guard)
 * and remembers it in the database, across Playwright workers and runs. A worker restarted after a
 * failure, or a run started right after another, reads what was spent and waits for a fresh step.
 */
const STEPS_FILE = join(tmpdir(), 'vibe-e2e-live-totp-steps.json')
const readSpent = (): Record<string, number> => {
    try {
        return JSON.parse(readFileSync(STEPS_FILE, 'utf8')) as Record<string, number>
    } catch {
        return {}
    }
}

/**
 * A code the server has not seen yet: the current step, or the next one (the server accepts one
 * step either way), waiting for the clock when both were spent already.
 */
export async function nextTotp(secret: string): Promise<string> {
    const spent = readSpent()[secret] ?? -1
    let step = Math.max(stepNow(), spent + 1)
    while (step > stepNow() + 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        step = Math.max(stepNow(), spent + 1)
    }
    writeFileSync(STEPS_FILE, JSON.stringify({ ...readSpent(), [secret]: step }))
    return totpAt(secret, step)
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
): Promise<{ context: BrowserContext; page: Page }> {
    devices += 1
    const address = `10.77.${String(Math.floor(devices / 250))}.${String((devices % 250) + 1)}`
    const context = await browser.newContext({
        baseURL: ORIGIN,
        extraHTTPHeaders: { 'x-forwarded-for': address },
    })
    const page = await context.newPage()
    return { context, page }
}

/**
 * A Chrome virtual authenticator (CDP) in this page's browser: a platform authenticator with user
 * verification. With the user present it answers at once, the autofill of the sign-in field
 * included (conditional UI); `present(false)` makes it wait, so a page can be used with the
 * password while a conditional request is pending.
 */
export async function withAuthenticator(
    page: Page,
): Promise<{ present: (on: boolean) => Promise<void> }> {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    })
    return {
        present: async (on) => {
            await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
                authenticatorId,
                enabled: on,
            })
        },
    }
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
    const answer = await signedIn
    expect(answer.status()).toBe(200)
    // feat-247: an account with an authenticator app (every staff account) has a second step.
    if (((await answer.json()) as { status?: string }).status === 'mfa_required') {
        await answerSecondStep(page, account)
    }
    await page.goto('/account')
    await expect(page.getByText(account.email)).toBeVisible()
}

/** The second step of the sign-in with the app's code (a spent step is tried once more). */
async function answerSecondStep(page: Page, account: Account): Promise<void> {
    const secret = account.totpSecret
    if (secret === undefined) throw new Error(`${account.email} asks for a second factor`)
    await expect(page.getByTestId('mfa-challenge')).toBeVisible()
    for (let attempt = 0; ; attempt += 1) {
        const verified = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === '/api/auth/mfa/verify' &&
                response.request().method() === 'POST',
        )
        await page.getByTestId('mfa-code').fill(await nextTotp(secret))
        await page.getByTestId('mfa-submit').click()
        const status = (await verified).status()
        // A step an earlier run spent (the database outlives a run) is refused once.
        if (status === 200 || attempt >= 1) {
            expect(status).toBe(200)
            return
        }
    }
}

/**
 * feat-247: sets up an authenticator app for the signed-in account of `request` (its sign-in a
 * moment ago is the fresh proof the first factor needs); answers the app's key.
 */
export async function enrollTotp(request: APIRequestContext): Promise<string> {
    const tab = session(request)
    const setup = await tab.post('/api/account/mfa/totp/setup', {})
    expect(setup.status()).toBe(200)
    const { enrollmentId, secret } = (await setup.json()) as {
        enrollmentId: string
        secret: string
    }
    const confirmed = await tab.post('/api/account/mfa/totp/confirm', {
        enrollmentId,
        code: await nextTotp(secret),
    })
    expect(confirmed.status()).toBe(200)
    return secret
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
export async function createVerifiedAccount(
    browser: Browser,
    sink: MailSink,
    password?: string,
): Promise<Account> {
    const account = { ...newAccount(), ...(password !== undefined && { password }) }
    const { context } = await newBrowser(browser)
    try {
        const tab = session(context.request)
        const registered = await tab.post('/api/auth/register/email', {
            name: 'Live E2E',
            email: account.email,
            password: account.password,
        })
        expect(registered.status()).toBe(200)

        const token = new URL(
            await linkFromMail(sink, account.email, '/verify-email'),
        ).searchParams.get('token')
        // feat-097: from a signed-out browser the registration link needs the password.
        const verified = await tab.post('/api/auth/verify-email', {
            token,
            password: account.password,
        })
        expect(verified.status()).toBe(200)
    } finally {
        await context.close()
    }
    return account
}

/**
 * feat-247 (Р10): a verified account with an authenticator app, which may be given a staff role
 * (an account without a second factor gets 409 mfa_not_enrolled). Nothing is signed in afterwards;
 * loginInUi signs it in with the app's code.
 */
export async function createStaffCandidate(browser: Browser, sink: MailSink): Promise<Account> {
    const account = await createVerifiedAccount(browser, sink)
    const { context, page } = await newBrowser(browser)
    try {
        await loginInUi(page, account)
        return { ...account, totpSecret: await enrollTotp(context.request) }
    } finally {
        await context.close()
    }
}
