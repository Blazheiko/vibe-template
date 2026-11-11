import { expect, test } from './support.js'

// feat-155 (review 2026-11-10, M4): the admin user list is paged. The first page says there is
// more and hands out a cursor; "Load more" asks for the page after it and adds it to the list.

const ADMIN = { id: '1', name: 'Admin', email: 'admin@example.test', role: 'admin' }

const user = (id: number) => ({
    id: String(id),
    name: `User ${String(id)}`,
    email: `user-${String(id)}@example.test`,
    registeredAt: '2026-11-10T10:00:00.000Z',
})

// Newest first: ids 101 … 2 on the first page, id 1 on the second.
const FIRST_PAGE = Array.from({ length: 100 }, (_, index) => user(101 - index))

test('the admin user list loads the next page through the cursor of the first', async ({
    page,
    api,
}) => {
    api.setSession(ADMIN)
    api.ignoreOtherRequests()
    const listRequests: URL[] = []
    page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.pathname === '/api/admin/users') listRequests.push(url)
    })
    await api.answer('admin/users?*', 200, {
        status: 'success',
        items: FIRST_PAGE,
        total: 101,
        nextCursor: '2',
        hasMore: true,
    })

    await page.goto('/admin/users')

    await expect(page.getByText('Loaded: 100 / 101')).toBeVisible()
    const loadMore = page.getByRole('button', { name: 'Load more' })
    await expect(loadMore).toBeVisible()
    await expect(page.getByRole('cell', { name: 'user-1@example.test', exact: true })).toHaveCount(
        0,
    )

    await api.answer('admin/users?*', 200, {
        status: 'success',
        items: [user(1)],
        total: 101,
        nextCursor: null,
        hasMore: false,
    })
    await loadMore.click()

    await expect(page.getByText('Loaded: 101 / 101')).toBeVisible()
    await expect(page.getByRole('cell', { name: 'user-1@example.test', exact: true })).toBeVisible()
    // The page that was shown is still there, and there is nothing more to load.
    await expect(
        page.getByRole('cell', { name: 'user-101@example.test', exact: true }),
    ).toBeVisible()
    await expect(loadMore).toHaveCount(0)

    expect(listRequests).toHaveLength(2)
    expect(listRequests[0]?.searchParams.get('cursor')).toBeNull()
    expect(listRequests[0]?.searchParams.get('limit')).toBe('100')
    expect(listRequests[1]?.searchParams.get('cursor')).toBe('2')
})
