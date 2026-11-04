import { afterEach, describe, expect, it, vi } from 'vitest'

// feat-115: start() marks the run before its first await, and every early exit (including a
// Redis that does not answer) puts the previous state back. The lock itself is covered on a real
// Redis in knowledge-base-init.redis.test.ts.

const acquireLease = vi.fn()
vi.mock('#app/services/shared/redis-lease.js', () => ({ acquireLease }))
const isConfigured = vi.fn(() => true)
vi.mock('#app/services/ai/adapters/openai-embedding-adapter.js', () => ({
    openaiEmbeddingAdapter: { isConfigured },
}))
vi.mock('#app/repositories/index.js', () => ({
    supportKnowledgeRepository: { findAll: vi.fn(() => Promise.resolve({ rows: [], total: 0 })) },
}))
vi.mock('#app/services/support/support-embedding-service.js', () => ({
    supportEmbeddingService: { indexArticle: vi.fn() },
}))
vi.mock('#logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const { createKnowledgeBaseInitService } = await import('./knowledge-base-init-service.js')

afterEach(() => {
    vi.clearAllMocks()
    isConfigured.mockReturnValue(true)
})

describe('knowledgeBaseInitService.start (feat-115)', () => {
    it('refuses a second call made while the first waits for the lock', async () => {
        let grant: (value: null) => void = () => undefined
        acquireLease.mockReturnValueOnce(
            new Promise((resolve) => {
                grant = resolve
            }),
        )
        const service = createKnowledgeBaseInitService()

        const first = service.start()
        const second = await service.start()
        grant(null)

        expect(second).toMatchObject({ ok: false, errorCode: 'ALREADY_RUNNING' })
        expect(acquireLease).toHaveBeenCalledTimes(1)
        expect(await first).toMatchObject({ ok: false, errorCode: 'ALREADY_RUNNING' })
        expect(service.getStatus().state).toBe('idle')
    })

    it('puts the state back when Redis does not answer', async () => {
        acquireLease.mockRejectedValueOnce(new Error('Redis unavailable'))
        const service = createKnowledgeBaseInitService()

        await expect(service.start()).rejects.toThrow('Redis unavailable')
        expect(service.getStatus().state).toBe('idle')
    })

    it('puts the state back when embeddings are not configured', async () => {
        isConfigured.mockReturnValue(false)
        const service = createKnowledgeBaseInitService()

        expect(await service.start()).toMatchObject({ errorCode: 'EMBEDDINGS_NOT_CONFIGURED' })
        expect(service.getStatus().state).toBe('idle')
        expect(acquireLease).not.toHaveBeenCalled()
    })
})
