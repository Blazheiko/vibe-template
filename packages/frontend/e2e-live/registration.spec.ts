import { expect, linkIn, loginInUi, newAccount, newBrowser, session, test } from './support'

// feat-069 (G3): registration, e-mail verification and login on the real backend, with the real
// throttle counters in Redis (strict registration: no sign-in before the address is confirmed).

test('register by e-mail, confirm the link, sign in', async ({ browser, sink }) => {
    const account = newAccount()
    const { page } = await newBrowser(browser)

    await page.goto('/')
    await page.getByRole('button', { name: 'Create Account' }).first().click()
    const modal = page.locator('.modal-overlay.show')
    await modal.locator('#register-name').fill('Live E2E')
    await modal.locator('#register-email').fill(account.email)
    await modal.locator('#register-password').fill(account.password)
    await modal.locator('#register-password-confirm').fill(account.password)
    await modal
        .locator('.checkbox-container', { hasText: 'I agree to the terms of service' })
        .click()
    await modal.getByRole('button', { name: 'Create Account', exact: true }).click()
    // Strict registration: the answer is the "check your inbox" text, nobody is signed in yet.
    await expect(modal.locator('.form-error')).toContainText('verification instructions')

    // Before the address is confirmed the right password is answered like a wrong one.
    const stranger = await newBrowser(browser)
    const early = await session(stranger.context.request).post('/api/auth/login', {
        identifier: account.email,
        password: account.password,
        token: '',
    })
    expect(early.status()).toBe(401)

    // That early login sent a second verification mail in the background (at most one per five
    // minutes, feat-066) and with it a new link: the first link stopped working.
    const mailsTo = (): number =>
        sink.mails.filter((mail) => mail.to.some((to) => to.toLowerCase() === account.email)).length
    await expect.poll(mailsTo).toBe(2)
    const [first = '', second = ''] = sink.mails
        .filter((mail) => mail.to.some((to) => to.toLowerCase() === account.email))
        .map((mail) => linkIn(mail.text, '/verify-email'))

    await page.goto(first)
    await expect(page.getByRole('heading', { name: 'Verification failed' })).toBeVisible()

    await page.goto(second)
    await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible()

    await loginInUi(page, account)
    expect(await session(page.context().request).whoAmI()).toBe(account.email)
})

test('the registration counter per address is real: the fourth try in an hour is refused', async ({
    browser,
}) => {
    const account = newAccount()
    const { context } = await newBrowser(browser)
    const tab = session(context.request)
    const body = { name: 'Live E2E', email: account.email, password: account.password, token: '' }

    for (let attempt = 1; attempt <= 3; attempt++) {
        expect(
            (await tab.post('/api/auth/register/email', body)).status(),
            `try ${String(attempt)}`,
        ).toBe(200)
    }
    const fourth = await tab.post('/api/auth/register/email', body)
    expect(fourth.status()).toBe(400)
    expect(await fourth.text()).toContain('Too many registration attempts')
})
