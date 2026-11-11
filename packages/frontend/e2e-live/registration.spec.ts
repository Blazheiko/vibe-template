import {
    createVerifiedAccount,
    expect,
    linkIn,
    loginInUi,
    newAccount,
    newBrowser,
    session,
    test,
} from './support'

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

    // feat-097: a registration link confirms the account only with its password.
    await page.goto(second)
    await page.getByLabel('Password').fill(account.password)
    await page.getByRole('button', { name: 'Confirm email' }).click()
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
    // feat-134 (L3): a spent auth throttle answers 429 rate_limited, as every other limit.
    expect(fourth.status()).toBe(429)
    expect(await fourth.text()).toContain('Too many registration attempts')
})

// feat-157 (review 2026-11-10): strict registration answers the same for a free and a taken
// address. What happens to the caller's stored session has to be the same too: it used to end
// only when the address was free, so a caller who was still signed in afterwards knew the email
// was registered.
test('strict registration ends the caller’s session the same way for a taken and a free address', async ({
    browser,
    sink,
}) => {
    const registered = await createVerifiedAccount(browser, sink)
    const callerA = await createVerifiedAccount(browser, sink)
    const callerB = await createVerifiedAccount(browser, sink)
    const a = await newBrowser(browser)
    const b = await newBrowser(browser)
    await loginInUi(a.page, callerA)
    await loginInUi(b.page, callerB)
    expect(await session(a.context.request).whoAmI()).toBe(callerA.email)
    expect(await session(b.context.request).whoAmI()).toBe(callerB.email)

    const register = (context: typeof a.context, email: string) =>
        session(context.request).post('/api/auth/register/email', {
            name: 'Probe',
            email,
            password: 'live-e2e-probe-pass-1',
            token: '',
        })
    const forTaken = await register(a.context, registered.email)
    const forFree = await register(b.context, newAccount().email)

    expect(forTaken.status()).toBe(200)
    expect(forFree.status()).toBe(200)
    expect(await forTaken.json()).toEqual(await forFree.json())
    // The same on both sides: neither caller is signed in any more.
    expect(await session(a.context.request).whoAmI()).toBeNull()
    expect(await session(b.context.request).whoAmI()).toBeNull()

    await a.context.close()
    await b.context.close()
})
