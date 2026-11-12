import {
    createVerifiedAccount,
    expect,
    linkFromMail,
    loginInUi,
    newBrowser,
    session,
    test,
} from './support'
import type { Account } from './support'

// feat-069 (G3): a session is revoked in *another browser* — what a mock cannot show. Two
// browser contexts share nothing but the account. Backend, PostgreSQL, Redis and the mail sink
// are real (playwright.live.config.ts); CSRF enforcement is on.

const NEW_PASSWORD = 'live-e2e-new-pass-1'

async function twoBrowsersSignedIn(browser: Parameters<typeof newBrowser>[0], account: Account) {
    const a = await newBrowser(browser)
    const b = await newBrowser(browser)
    await loginInUi(a.page, account)
    await loginInUi(b.page, account)
    expect(await session(a.context.request).whoAmI()).toBe(account.email)
    expect(await session(b.context.request).whoAmI()).toBe(account.email)
    return { a, b }
}

async function canLogIn(
    browser: Parameters<typeof newBrowser>[0],
    email: string,
    password: string,
): Promise<boolean> {
    const { context } = await newBrowser(browser)
    try {
        const response = await session(context.request).post('/api/auth/login', {
            identifier: email,
            password,
        })
        return response.status() === 200
    } finally {
        await context.close()
    }
}

test('a password reset by mail signs the other browsers out', async ({ browser, sink }) => {
    const account = await createVerifiedAccount(browser, sink)
    const { a, b } = await twoBrowsersSignedIn(browser, account)

    // A third browser, nobody signed in, asks for the reset link and follows it.
    const c = await newBrowser(browser)
    await c.page.goto('/')
    await c.page.getByRole('button', { name: 'Sign In' }).first().click()
    await c.page.getByText('Forgot password?').click()
    await c.page.locator('#forgot-identifier').fill(account.email)
    await c.page.getByRole('button', { name: 'Send reset link' }).click()
    await expect(c.page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()

    const link = await linkFromMail(sink, account.email, '/reset-password')
    await c.page.goto(link)
    await c.page.locator('#reset-password').fill(NEW_PASSWORD)
    await c.page.locator('#reset-password-confirm').fill(NEW_PASSWORD)
    await c.page.locator('button.reset-password-primary').click()
    await expect(c.page.getByRole('heading', { name: 'Password updated' })).toBeVisible()

    // Both earlier sessions are gone, in the API and in the page.
    expect(await session(a.context.request).whoAmI()).toBeNull()
    expect(await session(b.context.request).whoAmI()).toBeNull()
    await a.page.reload()
    await expect(a.page.getByText(account.email)).toHaveCount(0)
    await expect(a.page.getByRole('button', { name: 'Sign In' }).first()).toBeVisible()

    // The old password is dead, the new one works.
    expect(await canLogIn(browser, account.email, account.password)).toBe(false)
    expect(await canLogIn(browser, account.email, NEW_PASSWORD)).toBe(true)

    // The link is single-use.
    const again = await newBrowser(browser)
    await again.page.goto(link)
    await again.page.locator('#reset-password').fill('live-e2e-other-pass-1')
    await again.page.locator('#reset-password-confirm').fill('live-e2e-other-pass-1')
    await again.page.locator('button.reset-password-primary').click()
    await expect(again.page.getByRole('heading', { name: 'Password updated' })).toHaveCount(0)
    expect(await canLogIn(browser, account.email, 'live-e2e-other-pass-1')).toBe(false)
})

test('changing the password on the account page keeps this browser in and signs the other out', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const { a, b } = await twoBrowsersSignedIn(browser, account)

    await a.page.goto('/account')
    await a.page.locator('input[name="current-password"]').fill(account.password)
    await a.page.locator('input[name="new-password"]').fill(NEW_PASSWORD)
    await a.page.locator('input[name="confirm-password"]').fill(NEW_PASSWORD)
    await a.page.getByRole('button', { name: 'Update password' }).click()
    await expect(a.page.getByText('Password updated')).toBeVisible()

    // This browser got a fresh session (a new cookie) and goes on; the other one is out.
    expect(await session(a.context.request).whoAmI()).toBe(account.email)
    expect(await session(b.context.request).whoAmI()).toBeNull()
    await b.page.reload()
    await expect(b.page.getByText(account.email)).toHaveCount(0)

    expect(await canLogIn(browser, account.email, account.password)).toBe(false)
    expect(await canLogIn(browser, account.email, NEW_PASSWORD)).toBe(true)
})

test('"log out everywhere" ends every session, this one included', async ({ browser, sink }) => {
    const account = await createVerifiedAccount(browser, sink)
    const { a, b } = await twoBrowsersSignedIn(browser, account)

    const response = await session(a.context.request).post('/api/auth/logout-all', {})
    expect(response.status()).toBe(200)

    expect(await session(a.context.request).whoAmI()).toBeNull()
    expect(await session(b.context.request).whoAmI()).toBeNull()
    await b.page.reload()
    await expect(b.page.getByText(account.email)).toHaveCount(0)

    // The account itself is untouched: the password still works.
    expect(await canLogIn(browser, account.email, account.password)).toBe(true)
})

// feat-195 (M-1): the other browser sends nothing but heartbeats, and a heartbeat is not checked
// against the session. Its open WebSocket used to stay subscribed after the session was revoked;
// now the server tells it the session expired and closes it.
test('"log out everywhere" closes the open WebSocket of the other browser', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const a = await newBrowser(browser)
    const b = await newBrowser(browser)

    const sockets: { established: boolean; closed: boolean; sessionExpired: boolean }[] = []
    b.page.on('websocket', (ws) => {
        const socket = { established: false, closed: false, sessionExpired: false }
        sockets.push(socket)
        ws.on('framereceived', ({ payload }) => {
            const text = String(payload)
            if (text.includes('service:connection_established')) socket.established = true
            if (text.includes('session_expired')) socket.sessionExpired = true
        })
        ws.on('close', () => {
            socket.closed = true
        })
    })

    await loginInUi(a.page, account)
    await loginInUi(b.page, account)
    // The socket of the signed-in session is open (the server greeted it) and stays open on
    // its own. A socket that is still being opened when the session is revoked is closed too
    // (feat-209); this test is about one that is already open.
    const isOpen = (socket: (typeof sockets)[number]): boolean =>
        socket.established && !socket.closed
    await expect.poll(() => sockets.some(isOpen)).toBe(true)
    const open = sockets.filter(isOpen)

    const response = await session(a.context.request).post('/api/auth/logout-all', {})
    expect(response.status()).toBe(200)

    // No request from the other browser: the server closes its sockets by itself.
    await expect
        .poll(() => open.every((socket) => socket.closed && socket.sessionExpired), {
            timeout: 5000,
        })
        .toBe(true)
})
