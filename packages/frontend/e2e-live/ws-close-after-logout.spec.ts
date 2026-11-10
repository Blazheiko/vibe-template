import { createVerifiedAccount, expect, loginInUi, newBrowser, test } from './support'

// feat-151 (review 2026-11-10, M8): a sign-out closes the WebSocket on purpose. The close
// event of that socket used to be handled as a lost connection: five seconds later the client
// reconnected with the revoked token, the upgrade was refused, the token refresh answered 401,
// and the user — by then on another public page — was thrown back to /login.

test('a sign-out does not reconnect the WebSocket or pull the user back to /login', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const { context, page } = await newBrowser(browser)
    await loginInUi(page, account)

    await page.locator('button.menu-button').click()
    await page.locator('button.logout-item').click()
    await page.waitForURL('**/login')

    // What must not happen from here on.
    const tokenRefreshes: string[] = []
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/main/update-ws-token') {
            tokenRefreshes.push(request.method())
        }
    })
    const sockets: string[] = []
    page.on('websocket', (socket) => sockets.push(socket.url()))

    // Inside the application, without a reload: to the registration form.
    await page.getByRole('link', { name: 'Register' }).click()
    await page.waitForURL('**/register')

    // The reconnect used to fire five seconds after the close.
    await page.waitForTimeout(6500)

    expect(new URL(page.url()).pathname).toBe('/register')
    expect(sockets).toEqual([])
    expect(tokenRefreshes).toEqual([])

    await context.close()
})
