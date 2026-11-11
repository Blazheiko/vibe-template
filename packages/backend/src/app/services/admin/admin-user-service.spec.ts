import { beforeEach, describe, expect, it, vi } from 'vitest'

const listAdminUsers = vi.fn()
vi.mock('#app/repositories/index.js', () => ({ userRepository: { listAdminUsers } }))

const { adminUserService } = await import('./admin-user-service.js')

const row = (id: number) => ({
    id: BigInt(id),
    name: `User ${String(id)}`,
    email: `u${String(id)}@example.test`,
    createdAt: new Date(id * 1000),
})

beforeEach(() => {
    vi.clearAllMocks()
})

describe('adminUserService.listUsers', () => {
    it('passes the filters through, asking for one row more than the page, and maps rows to the response shape', async () => {
        listAdminUsers.mockResolvedValue({
            items: [
                { id: 5n, name: 'Ann', email: 'ann@example.test', createdAt: new Date(0) },
                { id: 6n, name: 'Bob', email: null, createdAt: new Date(1000) },
            ],
            total: 2,
        })

        const result = await adminUserService.listUsers({ userId: 5n, limit: 10 })

        expect(listAdminUsers).toHaveBeenCalledWith({ userId: 5n, limit: 11 })
        expect(result).toEqual({
            items: [
                {
                    id: '5',
                    name: 'Ann',
                    email: 'ann@example.test',
                    registeredAt: '1970-01-01T00:00:00.000Z',
                },
                { id: '6', name: 'Bob', email: '', registeredAt: '1970-01-01T00:00:01.000Z' },
            ],
            total: 2,
            nextCursor: null,
            hasMore: false,
        })
    })

    // feat-155: the extra row is the sign of a next page and is not part of this one.
    it('cuts the extra row off and hands out the id of the last user as the cursor', async () => {
        listAdminUsers.mockResolvedValue({ items: [row(9), row(8), row(7)], total: 40 })

        const result = await adminUserService.listUsers({ limit: 2 })

        expect(result.items.map((item) => item.id)).toEqual(['9', '8'])
        expect(result).toMatchObject({ total: 40, hasMore: true, nextCursor: '8' })
    })

    it('passes the cursor of the previous page to the repository', async () => {
        listAdminUsers.mockResolvedValue({ items: [row(7)], total: 40 })

        await adminUserService.listUsers({ limit: 2, cursor: 8n })

        expect(listAdminUsers).toHaveBeenCalledWith({ limit: 3, cursor: 8n })
    })

    it.each([
        [undefined, 101],
        [0, 2],
        [-5, 2],
        [200, 201],
        [5000, 201],
    ])('keeps the page between 1 and 200 rows: limit %s reads %i', async (limit, read) => {
        listAdminUsers.mockResolvedValue({ items: [], total: 0 })

        await adminUserService.listUsers(limit === undefined ? {} : { limit })

        expect(listAdminUsers).toHaveBeenCalledWith(expect.objectContaining({ limit: read }))
    })
})
