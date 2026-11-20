import { expect, test } from './support.js'

// feat-235 (Р10): the audit log page against a mocked API: the filters go into the address and the
// request, a row opens its changes, "Load more" asks for the page after the cursor.

const ADMIN = { id: '1', name: 'Admin', email: 'admin@example.test', role: 'admin' }

const event = (id: string, title: string) => ({
    id,
    occurredAt: '2026-11-20T10:00:00.000000Z',
    action: 'kb.article.updated',
    group: 'kb',
    actor: {
        kind: 'user',
        userId: '1',
        name: 'Admin',
        deleted: false,
        role: 'admin',
        proof: null,
        source: null,
    },
    target: { type: 'kb_article', id: '9' },
    targetUser: null,
    requestId: `0f8fad5b-d9cb-469f-a165-7086772895${id.padStart(2, '0')}`,
    changes: { title: { from: `${title} before`, to: `${title} after` } },
    metadata: null,
})

test('the audit log filters, opens a row and loads the next page', async ({ page, api }) => {
    api.setSession(ADMIN)
    api.ignoreOtherRequests()
    const requests: URL[] = []
    page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.pathname === '/api/admin/audit-events') requests.push(url)
    })
    await api.answer('admin/audit-events*', 200, {
        status: 'success',
        items: [event('2', 'Second')],
        nextCursor: 'cursor-1',
    })

    await page.goto('/admin/audit-log')
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Article updated' })).toBeVisible()

    // A filter goes into the address and the request.
    await page.locator('select[name="group"]').selectOption('kb')
    await page.locator('input[name="targetId"]').fill('9')
    await page.getByRole('button', { name: 'Apply' }).click()
    await expect(page).toHaveURL(/group=kb/)
    await expect(page).toHaveURL(/targetId=9/)
    await expect.poll(() => requests.at(-1)?.searchParams.get('group')).toBe('kb')
    expect(requests.at(-1)?.searchParams.get('targetId')).toBe('9')

    // A row opens its changes.
    await page.getByRole('cell', { name: 'Article updated' }).click()
    await expect(page.getByRole('cell', { name: 'Second before', exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Second after', exact: true })).toBeVisible()

    // The next page, after the cursor of this one.
    await api.answer('admin/audit-events*', 200, {
        status: 'success',
        items: [event('1', 'First')],
        nextCursor: null,
    })
    await page.getByRole('button', { name: 'Load more' }).click()
    await expect(page.getByRole('row').filter({ hasText: 'Article updated' })).toHaveCount(2)
    expect(requests.at(-1)?.searchParams.get('cursor')).toBe('cursor-1')
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)

    // The filters survive a reload.
    await page.reload()
    await expect(page.locator('input[name="targetId"]')).toHaveValue('9')
})
