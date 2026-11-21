import { describe, expect, it, vi } from 'vitest'

import type { WsContext } from '#vendor/types/types.js'
import { wsPermissionGuard } from './ws-permission-guard.js'

const wsContext = (userData: Record<string, unknown> | null) => ({
    userData,
    responseData: { status: '200', data: null, error: null, event: 'admin/x', timestamp: 0 },
    logger: { error: vi.fn() },
    signal: new AbortController().signal,
})

describe('ws_can:<permission> (feat-240)', () => {
    it.each([
        ['no user data', null],
        ['a user', { role: 'user' }],
        ['a role without the permission', { role: 'kb_editor' }],
        ['a paused admin channel', { role: 'admin', adminChannelPaused: true }],
    ])('answers 403 for %s and skips the handler', async (_name, userData) => {
        const context = wsContext(userData)
        const next = vi.fn()

        await wsPermissionGuard('users.read')(context as unknown as WsContext, next)

        expect(next).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe('403')
        expect(context.responseData.data).toEqual({
            status: 'error',
            code: 'forbidden',
            message: 'Access denied',
        })
    })

    it.each([['support_operator'], ['user_admin'], ['admin']])('lets %s through', async (role) => {
        const context = wsContext({ role, adminChannelPaused: false })
        const next = vi.fn(async () => {})

        await wsPermissionGuard('users.read')(context as unknown as WsContext, next)

        expect(next).toHaveBeenCalledOnce()
        expect(context.responseData.status).toBe('200')
    })
})
