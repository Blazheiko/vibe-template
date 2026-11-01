import { describe, expect, it } from 'vitest'
import { classifyWsMessage } from 'shared/ws-client'
import { buildWsEvent } from '@/utils/ws-event'

describe('classifyWsMessage', () => {
    it('routes a response under a non-api prefix to the pending request', () => {
        const event = buildWsEvent('user/me', 'v1')
        expect(event).toBe('v1/user/me')
        expect(classifyWsMessage(event, true)).toBe('api')
    })

    it('keeps service and broadcast events apart from API responses', () => {
        expect(classifyWsMessage('service:error', true)).toBe('service-error')
        expect(classifyWsMessage('service:pong', false)).toBe('service')
        expect(classifyWsMessage('broadcast:admin_user_online_remove', false)).toBe('broadcast')
    })

    it('ignores a response nobody waits for', () => {
        expect(classifyWsMessage('api/user/me', false)).toBe('unknown')
    })
})
