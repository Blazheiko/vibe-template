import type { APIRequestContext } from '@playwright/test'

import { ORIGIN, USER_2 } from './fixtures'
import {
    createVerifiedAccount,
    enrollTotp,
    expect,
    loginInUi,
    newBrowser,
    session,
    test,
} from './support'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11, Р13; tasks S4) against the real backend: a staff
// member with an authenticator app keeps the admin area open; the seeded admin resets their second
// factors; the session token rotates, the server closes the socket and the open admin tab leaves
// for the sign-in page.

const post = async (request: APIRequestContext, path: string, data: unknown) => {
    const token = await session(request).token()
    return request.post(path, { data, headers: { origin: ORIGIN, 'x-csrf-token': token } })
}

test('an MFA reset by the admin closes the open admin tab of the staff member', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)

    // The staff member signs in (a fresh password) and sets up an authenticator app.
    const staff = await newBrowser(browser)
    await loginInUi(staff.page, account)
    const init = (await (await staff.context.request.get('/api/main/init')).json()) as {
        user: { id: string }
    }
    const totpSecret = await enrollTotp(staff.context.request)

    // The admin makes them a support operator.
    const admin = await newBrowser(browser)
    await loginInUi(admin.page, USER_2)
    const token = await session(admin.context.request).token()
    const promoted = await admin.context.request.patch(`/api/admin/users/${init.user.id}/role`, {
        data: { role: 'support_operator' },
        headers: { origin: ORIGIN, 'x-csrf-token': token },
    })
    expect(promoted.status()).toBe(200)

    // feat-247 S5: the password session of the setup does not meet the staff rule; the admin
    // area sends it to the security section, which asks for a sign-in with the app.
    await staff.page.goto('/admin/users')
    await expect(staff.page).toHaveURL(/\/account\?section=security&reason=mfa_session_required$/)
    await expect(staff.page.getByTestId('staff-mfa-notice')).toContainText('Sign in again')
    await staff.context.close()

    // Signed in with the app, their tab opens the admin area.
    const member = await newBrowser(browser)
    await loginInUi(member.page, { ...account, totpSecret })
    await member.page.goto('/admin/users')
    await expect(member.page).toHaveURL(/\/admin\/users$/)
    await expect(member.page.locator('.admin-sidebar')).toBeVisible()

    // The admin resets the factors (the sign-in a moment ago is the fresh proof).
    const reset = await post(admin.context.request, `/api/admin/users/${init.user.id}/mfa/reset`, {
        reason: 'lost the phone',
    })
    expect(reset.status()).toBe(200)
    expect(await reset.json()).toMatchObject({ removed: { totp: true, recoveryCodes: 10 } })

    // The staff tab: its socket is closed by the server and the tab leaves for the sign-in.
    await expect(member.page).toHaveURL(/\/login/, { timeout: 15_000 })
    expect(await session(member.context.request).whoAmI()).toBeNull()

    // The account signs in again with the password alone: no second step any more.
    const again = await newBrowser(browser)
    await loginInUi(again.page, account)
    await again.context.close()
    await member.context.close()
    await admin.context.close()
})
