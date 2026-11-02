import { describe, expect, it, vi } from 'vitest'

import type { WsContext } from '#vendor/types/types.js'
import wsAdminGuard from './ws-admin-guard.js'

const wsContext = (role: string | undefined) => ({
    userData: role === undefined ? null : { role },
    responseData: { status: '200', data: null, error: null, event: 'admin/x', timestamp: 0 },
    logger: { error: vi.fn() },
    signal: new AbortController().signal,
})

describe('ws_admin_guard', () => {
    it.each([['user'], [undefined]])(
        'rejects role %s with 403 and skips the handler',
        async (role) => {
            const context = wsContext(role)
            const next = vi.fn()

            await wsAdminGuard(context as unknown as WsContext, next)

            expect(next).not.toHaveBeenCalled()
            expect(context.responseData.status).toBe('403')
            expect(context.responseData.data).toEqual({
                status: 'error',
                code: 'forbidden',
                message: 'Access denied',
            })
        },
    )

    it('lets an admin through', async () => {
        const context = wsContext('admin')
        const next = vi.fn(async () => {})

        await wsAdminGuard(context as unknown as WsContext, next)

        expect(next).toHaveBeenCalledOnce()
        expect(context.responseData.status).toBe('200')
    })
})
