import type { APIRequestContext } from '@playwright/test'

import { ORIGIN, USER_2 } from './fixtures'
import {
    createStaffCandidate,
    createVerifiedAccount,
    expect,
    loginInUi,
    newAccount,
    newBrowser,
    session,
    test,
    type Account,
} from './support'

// feat-241 (docs/plan/roles-permissions-plan.md Р6, Р8, Р10, Р11) against the real backend: the
// seeded admin (USER_2) gives roles from the user list and through the API; each role sees and may
// do only its part of the admin area; lowering the role of an open tab takes it out of the admin
// area without a reload (the role reaches its socket and the tab follows). feat-247: every staff
// account has an authenticator app and signs in with it (MFA_REQUIRED_FOR_STAFF); an account
// without one is not given a staff role.

const setRole = async (request: APIRequestContext, userId: string, role: string) => {
    const token = await session(request).token()
    return request.patch(`/api/admin/users/${userId}/role`, {
        data: { role },
        headers: { origin: ORIGIN, 'x-csrf-token': token },
    })
}

/** Signs `account` in, in a browser of its own; returns the page and its user id. */
const signedIn = async (browser: Parameters<typeof newBrowser>[0], account: Account) => {
    const tab = await newBrowser(browser)
    await loginInUi(tab.page, account)
    const init = (await (await tab.context.request.get('/api/main/init')).json()) as {
        user: { id: string }
    }
    return { ...tab, userId: init.user.id }
}

test('an admin makes a user a knowledge base editor from the list; the editor sees only the knowledge base', async ({
    browser,
    sink,
}) => {
    const account = await createStaffCandidate(browser, sink)
    const admin = await newBrowser(browser)
    await loginInUi(admin.page, USER_2)

    await admin.page.goto('/admin/users')
    const row = admin.page.getByRole('row').filter({ hasText: account.email })
    await row.getByRole('button', { name: 'Change role' }).click()
    const dialog = admin.page.getByRole('dialog', { name: 'Change role' })
    await dialog.getByLabel('Knowledge base editor').check()
    await dialog.getByRole('button', { name: 'Change role' }).click()
    await expect(row.getByRole('cell', { name: 'Knowledge base editor' })).toBeVisible()

    const editor = await signedIn(browser, account)
    await editor.page.goto('/admin')
    await expect(editor.page).toHaveURL(/\/admin\/knowledge-base$/)
    await expect(editor.page.locator('.admin-sidebar a')).toHaveText(['Knowledge Base'])
    await expect(editor.page.getByRole('button', { name: '+ New Article' })).toBeVisible()
    await expect(editor.page.getByRole('button', { name: 'Reindex All' })).toHaveCount(0)

    const created = await session(editor.context.request).post('/api/admin/knowledge-base', {
        title: `Editor ${account.email}`,
        content: 'Written by a knowledge base editor.',
    })
    expect(created.status()).toBe(201)
    expect((await editor.context.request.get('/api/admin/users')).status()).toBe(403)

    await admin.context.close()
    await editor.context.close()
})

test('a support operator reads but cannot change the knowledge base nor see connection history', async ({
    browser,
    sink,
}) => {
    const account = await createStaffCandidate(browser, sink)
    const operator = await signedIn(browser, account)
    const admin = await newBrowser(browser)
    await loginInUi(admin.page, USER_2)
    expect(
        (await setRole(admin.context.request, operator.userId, 'support_operator')).status(),
    ).toBe(200)

    await operator.page.goto('/admin/knowledge-base')
    await expect(operator.page.getByRole('heading', { name: 'Knowledge Base' })).toBeVisible()
    await expect(operator.page.getByRole('button', { name: 'Edit' })).toHaveCount(0)
    await expect(operator.page.getByRole('button', { name: '+ New Article' })).toHaveCount(0)
    const refused = await session(operator.context.request).post('/api/admin/knowledge-base', {
        title: 'Not allowed',
        content: 'An operator may not write.',
    })
    expect(refused.status()).toBe(403)

    await operator.page.goto('/admin/history-online')
    await expect(operator.page).toHaveURL(/\/admin\/knowledge-base$/)
    expect((await operator.context.request.get('/api/admin/history-online')).status()).toBe(403)

    await admin.context.close()
    await operator.context.close()
})

test('lowering the role of an open admin tab takes it to the account page without a reload', async ({
    browser,
    sink,
}) => {
    const account = await createStaffCandidate(browser, sink)
    const editor = await signedIn(browser, account)
    const admin = await newBrowser(browser)
    await loginInUi(admin.page, USER_2)
    expect((await setRole(admin.context.request, editor.userId, 'kb_editor')).status()).toBe(200)

    await editor.page.goto('/admin/knowledge-base')
    await expect(editor.page.getByRole('heading', { name: 'Knowledge Base' })).toBeVisible()
    // A marker that a reload would wipe.
    await editor.page.evaluate(() => {
        ;(window as unknown as { stillThere: boolean }).stillThere = true
    })

    expect((await setRole(admin.context.request, editor.userId, 'user')).status()).toBe(200)

    await expect(editor.page).toHaveURL(/\/account$/, { timeout: 10_000 })
    expect(
        await editor.page.evaluate(
            () => (window as unknown as { stillThere?: boolean }).stillThere,
        ),
    ).toBe(true)

    await admin.context.close()
    await editor.context.close()
})

test('a staff role cannot be given to an account whose email is not verified', async ({
    browser,
}) => {
    const account = newAccount()
    const visitor = await newBrowser(browser)
    const registered = await session(visitor.context.request).post('/api/auth/register/email', {
        name: 'Unverified',
        email: account.email,
        password: account.password,
    })
    expect(registered.status()).toBe(200)
    await visitor.context.close()

    const admin = await newBrowser(browser)
    await loginInUi(admin.page, USER_2)
    await admin.page.goto('/admin/users')
    const row = admin.page.getByRole('row').filter({ hasText: account.email })
    await row.getByRole('button', { name: 'Change role' }).click()
    const dialog = admin.page.getByRole('dialog', { name: 'Change role' })
    await expect(dialog.getByLabel('Support operator')).toBeDisabled()

    await admin.context.close()
})

// feat-247 (Р10): no staff account without a second factor, from the list or through the API.
test('a staff role cannot be given to an account without a second factor', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const target = await signedIn(browser, account)
    await target.context.close()

    const admin = await newBrowser(browser)
    await loginInUi(admin.page, USER_2)
    const refused = await setRole(admin.context.request, target.userId, 'kb_editor')
    expect(refused.status()).toBe(409)
    expect(await refused.json()).toMatchObject({ reason: 'mfa_not_enrolled' })

    await admin.page.goto('/admin/users')
    const row = admin.page.getByRole('row').filter({ hasText: account.email })
    await row.getByRole('button', { name: 'Change role' }).click()
    const dialog = admin.page.getByRole('dialog', { name: 'Change role' })
    await dialog.getByLabel('Support operator').check()
    await dialog.getByRole('button', { name: 'Change role' }).click()
    await expect(dialog.getByRole('alert')).toContainText('needs two-step sign-in')
    await expect(row.getByRole('cell', { name: 'User', exact: true })).toBeVisible()

    await admin.context.close()
})
