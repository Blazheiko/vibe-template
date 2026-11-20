import { randomUUID } from 'node:crypto'

import { USER_2 } from './fixtures'
import { createVerifiedAccount, expect, loginInUi, newBrowser, session, test } from './support'

// feat-235 (Р10, Р13): the audit log against the real backend. The seeded admin (USER_2) edits an article in the knowledge-base UI and a prompt through
// PUT /prompts/:type (there is no prompt page) and finds both events under its name; a user changes
// the password and signs out everywhere, and the admin finds those events by the account.

test('an admin finds its own article and prompt edits under its name', async ({ browser }) => {
    const { context, page } = await newBrowser(browser)
    await loginInUi(page, USER_2)
    const api = session(context.request)
    // Its name as the backend has it now (another spec may have renamed the account).
    const me = (await (await context.request.get('/api/main/init')).json()) as {
        user: { name: string }
    }
    const adminName = me.user.name
    const title = `Audit ${randomUUID().slice(0, 8)}`

    const created = await api.post('/api/admin/knowledge-base', {
        title,
        content: 'An article the audit log test edits.',
    })
    expect(created.status()).toBe(201)
    const articleId = ((await created.json()) as { data: { id: string } }).data.id

    // The edit goes through the knowledge-base page.
    await page.goto('/admin/knowledge-base')
    const row = page.getByRole('row').filter({ hasText: title })
    await row.getByRole('button', { name: 'Edit' }).click()
    await page.getByPlaceholder('Article title').fill(`${title} edited`)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('row').filter({ hasText: `${title} edited` })).toBeVisible()

    const token = await api.token()
    const prompt = await context.request.put('/api/prompts/SUPPORT_SYSTEM', {
        data: { model: `audit-model-${randomUUID().slice(0, 6)}` },
        headers: { origin: page.url().replace(/\/admin.*$/, ''), 'x-csrf-token': token },
    })
    expect(prompt.status()).toBe(200)

    // The history of the article, from its row.
    await page
        .getByRole('row')
        .filter({ hasText: `${title} edited` })
        .getByRole('link', { name: 'History' })
        .click()
    await expect(page).toHaveURL(new RegExp(`targetId=${articleId}`))
    const articleRows = page.getByTestId('audit-row')
    await expect(articleRows).toHaveCount(2)
    await expect(articleRows.nth(0)).toContainText('Article updated')
    await expect(articleRows.nth(0)).toContainText(adminName)
    await expect(articleRows.nth(1)).toContainText('Article created')
    await articleRows.nth(0).click()
    await expect(page.getByTestId('audit-details')).toContainText(`${title} edited`)

    await page.goto('/admin/audit-log?group=ai&targetId=SUPPORT_SYSTEM')
    await expect(page.getByTestId('audit-row').first()).toContainText('AI prompt updated')
    await expect(page.getByTestId('audit-row').first()).toContainText(adminName)

    await context.close()
})

test('an admin finds a password change and a logout everywhere by the account', async ({
    browser,
    sink,
}) => {
    const account = await createVerifiedAccount(browser, sink)
    const user = await newBrowser(browser)
    await loginInUi(user.page, account)
    const init = (await (await user.context.request.get('/api/main/init')).json()) as {
        user: { id: string }
    }
    const userId = init.user.id

    // The password change goes through the account page.
    const newPassword = 'live-e2e-pass-changed'
    await user.page.locator('input[name="current-password"]').fill(account.password)
    await user.page.locator('input[name="new-password"]').fill(newPassword)
    await user.page.locator('input[name="confirm-password"]').fill(newPassword)
    const changed = user.page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/auth/change-password',
    )
    await user.page.getByRole('button', { name: 'Update password' }).click()
    expect((await changed).status()).toBe(200)
    // There is no "sign out everywhere" button in the app; the API it calls.
    const loggedOut = await session(user.context.request).post('/api/auth/logout-all', {})
    expect(loggedOut.status()).toBe(200)
    await user.context.close()

    const admin = await newBrowser(browser)
    await loginInUi(admin.page, USER_2)
    await admin.page.goto(`/admin/audit-log?targetUserId=${userId}`)
    const rows = admin.page.getByTestId('audit-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText('Signed out everywhere')
    await expect(rows.nth(1)).toContainText('Password changed')
    await expect(rows.nth(1)).toContainText(`Account #${userId}`)
    await admin.context.close()
})
