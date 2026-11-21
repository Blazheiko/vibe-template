import { expect, test } from './support.js'

// feat-240 (docs/plan/roles-permissions-plan.md Р10): each role sees the admin pages it may use,
// `/admin` opens the first of them, a page it may not use goes to that first page, and a role
// without admin permissions goes to the account page. The backend checks every request anyway.

const session = (role: string) => ({
    id: '1',
    name: 'Staff',
    email: 'staff@example.test',
    role,
})

const MENU = ['Knowledge Base', 'Users', 'User Online', 'History Online', 'Audit Log']

const cases = [
    {
        role: 'support_operator',
        first: '/admin/knowledge-base',
        menu: ['Knowledge Base', 'Users', 'User Online', 'Audit Log'],
    },
    {
        role: 'kb_editor',
        first: '/admin/knowledge-base',
        menu: ['Knowledge Base'],
    },
    {
        role: 'user_admin',
        first: '/admin/users',
        menu: ['Users', 'User Online', 'Audit Log'],
    },
    { role: 'admin', first: '/admin/knowledge-base', menu: MENU },
] as const

for (const { role, first, menu } of cases) {
    test(`${role}: the menu and /admin`, async ({ page, api }) => {
        api.setSession(session(role))
        api.ignoreOtherRequests()

        await page.goto('/admin')

        await expect(page).toHaveURL(new RegExp(`${first}$`))
        const sidebar = page.locator('.admin-sidebar')
        for (const label of MENU) {
            await expect(sidebar.getByText(label, { exact: true })).toHaveCount(
                (menu as readonly string[]).includes(label) ? 1 : 0,
            )
        }
    })
}

const REFUSED = [
    { role: 'support_operator', first: '/admin/knowledge-base', refused: '/admin/history-online' },
    { role: 'kb_editor', first: '/admin/knowledge-base', refused: '/admin/users' },
    { role: 'user_admin', first: '/admin/users', refused: '/admin/knowledge-base' },
] as const

for (const { role, first, refused } of REFUSED) {
    test(`${role}: a page it may not use goes to its first page`, async ({ page, api }) => {
        api.setSession(session(role))
        api.ignoreOtherRequests()

        await page.goto(refused)

        await expect(page).toHaveURL(new RegExp(`${first}$`))
    })
}

test('a user without admin permissions goes to the account page', async ({ page, api }) => {
    api.setSession(session('user'))
    api.ignoreOtherRequests()

    await page.goto('/admin/knowledge-base')

    await expect(page).toHaveURL(/\/account$/)
})
