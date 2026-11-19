import type { Page } from '@playwright/test'

import { createVerifiedAccount, expect, loginInUi, newBrowser, session, test } from './support'
import type { Account } from './support'

// feat-233 T6: the session list of the account page against the real backend, two browsers of
// one account. Each browser is its own device for the backend (an address of its own in
// X-Forwarded-For), so the list tells them apart.

const sessions = (page: Page) => page.getByTestId('active-sessions')
const others = (page: Page) => sessions(page).getByTestId('session-other')

async function twoBrowsers(browser: Parameters<typeof newBrowser>[0], account: Account) {
    const a = await newBrowser(browser)
    const b = await newBrowser(browser)
    await loginInUi(a.page, account)
    await loginInUi(b.page, account)
    return { a, b }
}

test('one browser ends the other: the other lands on the sign-in page', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const { a, b } = await twoBrowsers(browser, account)

    await expect(sessions(a.page).getByTestId('session-current')).toContainText('This device')
    await expect(others(a.page)).toHaveCount(1)
    // b has the account page open, so its socket is open: online.
    await expect(others(a.page).getByTestId('session-online')).toBeVisible()

    await others(a.page).getByTestId('session-end').click()
    await a.page.getByTestId('confirm-accept').click()
    await expect(sessions(a.page).getByTestId('sessions-notice')).toHaveText(
        'The session was ended',
    )
    await expect(others(a.page)).toHaveCount(0)

    // The server closed b's socket (4001); its token refresh finds no session and signs it out.
    await b.page.waitForURL('**/login')
    expect(await session(b.context.request).whoAmI()).toBeNull()
    expect(await session(a.context.request).whoAmI()).toBe(account.email)

    await a.context.close()
    await b.context.close()
})

test('the online badge of the other browser goes off when it closes', async ({ browser, sink }) => {
    const account = await createVerifiedAccount(browser, sink)
    const { a, b } = await twoBrowsers(browser, account)

    await expect(others(a.page).getByTestId('session-online')).toBeVisible()
    await b.context.close()
    // The last socket of b's session closed: the list is read again on its event.
    await expect(others(a.page)).toHaveCount(1)
    await expect(others(a.page).getByTestId('session-online')).toHaveCount(0)

    await a.context.close()
})

test('ending all other sessions keeps this browser signed in and working', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const { a, b } = await twoBrowsers(browser, account)
    const c = await newBrowser(browser)
    await loginInUi(c.page, account)
    await expect(others(a.page)).toHaveCount(2)

    await sessions(a.page).getByTestId('sessions-end-others').click()
    await a.page.getByTestId('confirm-accept').click()
    await expect(sessions(a.page).getByTestId('sessions-notice')).toHaveText(
        'All other sessions were ended',
    )
    await expect(others(a.page)).toHaveCount(0)

    await b.page.waitForURL('**/login')
    await c.page.waitForURL('**/login')
    // This browser: renewed session, the page still works (a change with the new CSRF token).
    expect(await session(a.context.request).whoAmI()).toBe(account.email)
    await a.page.reload()
    await expect(sessions(a.page).getByTestId('session-current')).toBeVisible()
    await expect(a.page.getByText(account.email)).toBeVisible()

    await a.context.close()
    await b.context.close()
    await c.context.close()
})

test('a sign-in from a new device is mailed with its details and a link to the list', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const notices = () =>
        sink.mails.filter(
            (mail) => mail.to.includes(account.email) && mail.text.includes('/account#sessions'),
        )
    const a = await newBrowser(browser)
    await loginInUi(a.page, account)
    // The first sign-in: no other session, so not a familiar device.
    await expect.poll(() => notices().length).toBe(1)

    // Another browser on another address: not familiar either.
    const b = await newBrowser(browser)
    await loginInUi(b.page, account)
    await expect.poll(() => notices().length).toBe(2)
    const [first, second] = notices()
    expect(second).toBeDefined()
    expect(second.text).toContain('IP address: 10.77.')
    expect(second.text).not.toBe(first.text)

    await a.context.close()
    await b.context.close()
})
