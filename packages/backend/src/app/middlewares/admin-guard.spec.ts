import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HttpContext } from '#vendor/types/types.js'

const findRole = vi.fn()
vi.mock('#app/services/user/user-role-service.js', () => ({ userRoleService: { findRole } }))

const { default: adminGuard } = await import('./admin-guard.js')

const context = (userId: string | null) =>
    ({
        auth: { getUserId: () => userId },
        responseData: { status: 200, payload: null },
    }) as unknown as HttpContext

afterEach(() => {
    vi.clearAllMocks()
})

describe('admin_guard', () => {
    it.each([
        ['an anonymous request', null, undefined],
        ['a regular user', '7', 'user'],
        ['a deleted user', '7', undefined],
    ])('answers 403 for %s', async (_name, userId, role) => {
        findRole.mockResolvedValue(role)
        const ctx = context(userId)
        const next = vi.fn()

        await adminGuard(ctx, next)

        expect(next).not.toHaveBeenCalled()
        expect(ctx.responseData.status).toBe(403)
        expect(ctx.responseData.payload).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Admin access required',
        })
    })

    it('lets an admin through, looking the role up by service', async () => {
        findRole.mockResolvedValue('admin')
        const ctx = context('7')
        const next = vi.fn(async () => {})

        await adminGuard(ctx, next)

        expect(findRole).toHaveBeenCalledWith(7n)
        expect(next).toHaveBeenCalledOnce()
    })
})
