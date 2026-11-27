import { describe, expect, it, vi } from 'vitest'

import type { UserConnection, WsContext, WsData, WsResponseData } from '#vendor/types/types.js'

vi.mock('#vendor/utils/logger.js', () => ({
    default: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}))

const createWsContext = (await import('./ws-context.js')).default

const ws = { id: 'c1' }
const wsData = { ws, middlewareData: {}, status: '200', payload: {} } as unknown as WsData
const responseData = {
    data: null,
    event: 'main:ping',
    timestamp: 1,
    status: '200',
    error: null,
} as unknown as WsResponseData
const userData = { userId: '9', sessionId: 's1', userToken: 'u1' } as unknown as UserConnection

// feat-274: the session is checked before dispatch; the context carries no session or auth.
describe('createWsContext', () => {
    it('has no session and no auth, and passes the connection data through', () => {
        const context = createWsContext(wsData, responseData, userData)

        expect('session' in context).toBe(false)
        expect('auth' in context).toBe(false)
        expect(context.userData).toBe(userData)
        expect(context.ws).toBe(ws)
        expect(context.wsData).toBe(wsData)
        expect(context.responseData).toBe(responseData)
    })

    it('does not compile a read of session or auth', () => {
        const context: WsContext = createWsContext(wsData, responseData, null)
        // @ts-expect-error feat-274: WsContext has no session
        expect(context.session).toBeUndefined()
        // @ts-expect-error feat-274: WsContext has no auth
        expect(context.auth).toBeUndefined()
    })
})
