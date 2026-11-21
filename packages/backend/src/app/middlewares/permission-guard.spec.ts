import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HttpContext } from '#vendor/types/types.js'

const findRole = vi.fn()
vi.mock('#app/services/user/user-role-service.js', () => ({ userRoleService: { findRole } }))
const rememberActorRole = vi.fn()
vi.mock('#app/controllers/shared/audit-actor.js', () => ({ rememberActorRole }))

const { permissionGuard } = await import('./permission-guard.js')

const context = (userId: string | null) =>
    ({
        auth: { getUserId: () => userId },
        responseData: { status: 200, payload: null },
    }) as unknown as HttpContext

afterEach(() => {
    vi.clearAllMocks()
})

describe('can:<permission> (feat-240)', () => {
    it.each([
        ['an anonymous request', null, undefined],
        ['a user', '7', 'user'],
        ['a deleted user', '7', undefined],
        ['a role without the permission', '7', 'support_operator'],
    ])('answers the canonical 403 for %s', async (_name, userId, role) => {
        findRole.mockResolvedValue(role)
        const ctx = context(userId)
        const next = vi.fn()

        await permissionGuard('kb.write')(ctx, next)

        expect(next).not.toHaveBeenCalled()
        expect(rememberActorRole).not.toHaveBeenCalled()
        expect(ctx.responseData.status).toBe(403)
        expect(ctx.responseData.payload).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Access denied',
        })
    })

    it.each([['kb_editor'], ['admin']])(
        'lets %s through and remembers the role it read',
        async (role) => {
            findRole.mockResolvedValue(role)
            const ctx = context('7')
            const next = vi.fn(async () => {})

            await permissionGuard('kb.write')(ctx, next)

            expect(findRole).toHaveBeenCalledWith(7n)
            expect(rememberActorRole).toHaveBeenCalledWith(ctx, role)
            expect(next).toHaveBeenCalledOnce()
            expect(ctx.responseData.status).toBe(200)
        },
    )
})
