import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import pg from 'pg'
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
const createMany = vi.hoisted(() => vi.fn())
vi.mock('#app/repositories/index.js', () => ({
    supportKnowledgeRepository: {
        findAll: vi.fn(() => Promise.resolve({ rows: [], total: 0 })),
        createMany,
    },
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

// feat-126: the init status is served by the admin API; a database error shows its safe message.
describe('knowledgeBaseInitService status after a database failure (feat-126)', () => {
    it('names the database error without the text PostgreSQL quoted', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'kb-status-'))
        await writeFile(join(dir, 'a-account.txt'), 'Title\n\nBody\n')
        const failure = new pg.DatabaseError('value too long for "secret-title"', 0, 'error')
        failure.code = '22001'
        failure.severity = 'ERROR'
        failure.routine = 'varchar'
        failure.detail = 'Key (title)=(secret-title) is too long.'
        createMany.mockRejectedValue(failure)
        acquireLease.mockResolvedValue({
            lost: new AbortController().signal,
            release: () => Promise.resolve(true),
        })
        const service = createKnowledgeBaseInitService({
            resolveSourceDir: () => Promise.resolve(dir),
            delayMs: 0,
        })

        expect((await service.start()).ok).toBe(true)
        await service.running

        expect(service.getStatus()).toMatchObject({
            state: 'failed',
            message: 'Database error (code=22001)',
        })
        expect(JSON.stringify(service.getStatus())).not.toContain('secret-title')
        await rm(dir, { recursive: true, force: true })
    })
})
