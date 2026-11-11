import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi: vi.fn() }),
}))

vi.mock('../event-bus', () => ({ useEventBus: () => ({ emit: vi.fn() }) }))

const http = vi.hoisted(() => vi.fn())
vi.mock('../base-api', () => ({ default: { http } }))

// Through the typed client (ADR 0005): the method and the URL are the first two arguments of the
// transport; an empty body and no options follow.
const lastRequest = (): unknown[] => (http.mock.lastCall ?? []).slice(0, 2)

describe('the admin list requests', () => {
    beforeEach(() => {
        http.mockReset()
        http.mockResolvedValue({ data: null, error: null })
    })

    it('users: limit, trimmed user id, dates; a blank id or date is not sent', async () => {
        const { adminUsersApi } = await import('../api')
        await adminUsersApi.list({ limit: 20, userId: '  42 ', dateFrom: '2026-01-01', dateTo: '' })
        expect(lastRequest()).toEqual([
            'GET',
            '/api/admin/users?limit=20&userId=42&dateFrom=2026-01-01',
        ])

        await adminUsersApi.list({ userId: '   ' })
        expect(lastRequest()).toEqual(['GET', '/api/admin/users'])
        await adminUsersApi.list()
        expect(lastRequest()).toEqual(['GET', '/api/admin/users'])
    })

    it('online history: the cursor goes between the limit and the user id', async () => {
        const { adminOnlineHistoryApi } = await import('../api')
        await adminOnlineHistoryApi.list({
            limit: 50,
            cursor: '812',
            userId: '7',
            dateTo: '2026-02-01',
        })
        expect(lastRequest()).toEqual([
            'GET',
            '/api/admin/history-online?limit=50&cursor=812&userId=7&dateTo=2026-02-01',
        ])
        await adminOnlineHistoryApi.list({ cursor: '' })
        expect(lastRequest()).toEqual(['GET', '/api/admin/history-online'])
    })

    it('knowledge base: category, page, limit', async () => {
        const { adminKnowledgeBaseApi } = await import('../api')
        http.mockResolvedValue({ data: { status: 'ok', data: [], total: 0 }, error: null })
        await adminKnowledgeBaseApi.getAll({ category: 'billing & plans', page: 2, limit: 25 })
        expect(lastRequest()).toEqual([
            'GET',
            // A contract encodes a space as %20 (encodeURIComponent); the server reads it the same as +.
            '/api/admin/knowledge-base?category=billing%20%26%20plans&page=2&limit=25',
        ])
        await adminKnowledgeBaseApi.getAll({ category: '' })
        expect(lastRequest()).toEqual(['GET', '/api/admin/knowledge-base'])
    })

    // feat-162: a failed list is an error, not an empty knowledge base.
    it('knowledge base: a failed list throws the message of the response', async () => {
        const { adminKnowledgeBaseApi } = await import('../api')
        http.mockResolvedValue({
            data: { status: 'error', code: 'internal_error', message: 'Internal server error' },
            error: { code: 'internal_error', transportCode: 500, message: 'Internal server error' },
        })

        await expect(adminKnowledgeBaseApi.getAll()).rejects.toThrow('Internal server error')
    })

    it('knowledge base: reindex-all returns the failed ids, and null when it fails', async () => {
        const { adminKnowledgeBaseApi } = await import('../api')
        http.mockResolvedValueOnce({
            data: { status: 'ok', indexed: 3, failed: ['4'] },
            error: null,
        })
        expect(await adminKnowledgeBaseApi.reindexAll()).toEqual({ indexed: 3, failed: ['4'] })

        http.mockResolvedValueOnce({ data: null, error: { code: 'x', transportCode: 500 } })
        expect(await adminKnowledgeBaseApi.reindexAll()).toBeNull()
    })

    it('an online user is fetched by its encoded id', async () => {
        const { adminOnlineUsersApi } = await import('../api')
        await adminOnlineUsersApi.getById('a/b?c')
        expect(lastRequest()).toEqual(['GET', '/api/admin/users-online/a%2Fb%3Fc'])
    })
})
