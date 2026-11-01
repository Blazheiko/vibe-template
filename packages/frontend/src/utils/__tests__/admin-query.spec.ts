import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adminQueryString } from '../admin-query'

vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi: vi.fn() }),
}))

vi.mock('../event-bus', () => ({ useEventBus: () => ({ emit: vi.fn() }) }))

const http = vi.hoisted(() => vi.fn())
vi.mock('../base-api', () => ({ default: { http } }))

describe('adminQueryString', () => {
    it('is empty when nothing is left', () => {
        expect(adminQueryString({})).toBe('')
        expect(adminQueryString({ a: undefined, b: '' })).toBe('')
    })

    it('leaves out undefined and empty strings, keeps zero, and keeps the order', () => {
        expect(adminQueryString({ limit: 0, cursor: '', userId: undefined, page: 2 })).toBe(
            '?limit=0&page=2',
        )
    })

    it('encodes the values', () => {
        expect(adminQueryString({ q: 'a b&c=d/é' })).toBe('?q=a+b%26c%3Dd%2F%C3%A9')
    })
})

describe('the admin list requests', () => {
    beforeEach(() => {
        http.mockReset()
        http.mockResolvedValue({ data: null, error: null })
    })

    it('users: limit, trimmed user id, dates; a blank id or date is not sent', async () => {
        const { adminUsersApi } = await import('../api')
        await adminUsersApi.list({ limit: 20, userId: '  42 ', dateFrom: '2026-01-01', dateTo: '' })
        expect(http).toHaveBeenLastCalledWith(
            'GET',
            '/api/admin/users?limit=20&userId=42&dateFrom=2026-01-01',
        )

        await adminUsersApi.list({ userId: '   ' })
        expect(http).toHaveBeenLastCalledWith('GET', '/api/admin/users')
        await adminUsersApi.list()
        expect(http).toHaveBeenLastCalledWith('GET', '/api/admin/users')
    })

    it('online history: the cursor goes between the limit and the user id', async () => {
        const { adminOnlineHistoryApi } = await import('../api')
        await adminOnlineHistoryApi.list({
            limit: 50,
            cursor: '812',
            userId: '7',
            dateTo: '2026-02-01',
        })
        expect(http).toHaveBeenLastCalledWith(
            'GET',
            '/api/admin/history-online?limit=50&cursor=812&userId=7&dateTo=2026-02-01',
        )
        await adminOnlineHistoryApi.list({ cursor: '' })
        expect(http).toHaveBeenLastCalledWith('GET', '/api/admin/history-online')
    })

    it('knowledge base: category, page, limit', async () => {
        const { adminKnowledgeBaseApi } = await import('../api')
        await adminKnowledgeBaseApi.getAll({ category: 'billing & plans', page: 2, limit: 25 })
        expect(http).toHaveBeenLastCalledWith(
            'GET',
            '/api/admin/knowledge-base?category=billing+%26+plans&page=2&limit=25',
        )
        await adminKnowledgeBaseApi.getAll({ category: '' })
        expect(http).toHaveBeenLastCalledWith('GET', '/api/admin/knowledge-base')
    })

    it('an online user is fetched by its encoded id', async () => {
        const { adminOnlineUsersApi } = await import('../api')
        await adminOnlineUsersApi.getById('a/b?c')
        expect(http).toHaveBeenLastCalledWith('GET', '/api/admin/users-online/a%2Fb%3Fc')
    })
})
