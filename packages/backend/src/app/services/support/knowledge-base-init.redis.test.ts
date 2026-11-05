import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../../test-support/redis-test-client.js'

// feat-115 (R11c) on a real Redis: the knowledge-base import runs once.
// - two start() calls in one process -> one import;
// - two instances (two services sharing Redis) -> one gets the lock;
// - an instance whose lease was lost (the key expired and another instance took it) cannot renew
//   or delete the other's lock, and its import stops before the next write.

const { PREFIX } = vi.hoisted(() => ({ PREFIX: `test:${crypto.randomUUID()}:` }))

vi.mock('#config/redis.js', async (importActual) => {
    const actual = await importActual<{ default: object }>()
    return { default: { ...actual.default, keyPrefix: PREFIX } }
})
vi.mock('#database/redis.js', async () => {
    const { Redis: Client } = await import('ioredis')
    const { mainRedisOptions } = await import('#database/redis-main-options.js')
    const { createRedisHealth, createWithRedis } = await import('#database/redis-health.js')
    const { host: _host, port: _port, ...contract } = mainRedisOptions
    const client = new Client(process.env['REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379', {
        ...contract,
        keyPrefix: PREFIX,
        lazyConnect: true,
    })
    const redisHealth = createRedisHealth(client, {
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    })
    return { default: client, redisHealth, withRedis: createWithRedis(client, redisHealth) }
})

const kb = vi.hoisted(() => ({
    articles: 0,
    created: [] as string[],
    // When set, indexArticle waits for the test to let it go.
    hold: false,
    held: [] as (() => void)[],
    signals: [] as (AbortSignal | undefined)[],
}))
vi.mock('#app/repositories/index.js', () => ({
    supportKnowledgeRepository: {
        findAll: () => Promise.resolve({ rows: [], total: kb.articles }),
        // feat-125: every article in one statement.
        createMany: (articles: { title: string; content: string }[]) =>
            Promise.resolve(
                articles.map((data) => {
                    kb.articles += 1
                    kb.created.push(data.title)
                    return {
                        id: BigInt(kb.articles),
                        title: data.title,
                        content: data.content,
                        contentVersion: 1,
                    }
                }),
            ),
    },
}))
vi.mock('#app/services/support/support-embedding-service.js', () => ({
    supportEmbeddingService: {
        // Like the real one: the lease signal cancels the provider wait (feat-125, the review found
        // the old mock ignored it).
        indexArticle: (_article: unknown, options?: { signal?: AbortSignal }) => {
            kb.signals.push(options?.signal)
            if (!kb.hold) return Promise.resolve(true)
            return new Promise<boolean>((resolve, reject) => {
                kb.held.push(() => {
                    resolve(true)
                })
                options?.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason as Error)
                })
            })
        },
    },
}))
vi.mock('#app/services/ai/adapters/openai-embedding-adapter.js', () => ({
    openaiEmbeddingAdapter: { isConfigured: () => true },
}))
const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
vi.mock('#logger', () => ({ default: silent }))

const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { stop(): void }
}
const { createKnowledgeBaseInitService, KB_INIT_LOCK_KEY } =
    await import('./knowledge-base-init-service.js')

const admin = createTestRedis(PREFIX)
const LONG = { ttlMs: 60_000, renewEveryMs: 20_000, maxLifetimeMs: 120_000 }
let sourceDir = ''

const until = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 300; i += 1) {
        if (await condition()) return
        await sleep(10)
    }
    throw new Error('condition not reached')
}

const instance = (lease = LONG) =>
    createKnowledgeBaseInitService({
        lease,
        resolveSourceDir: () => Promise.resolve(sourceDir),
        delayMs: 0,
    })

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
    sourceDir = await mkdtemp(join(tmpdir(), 'kb-init-'))
    for (const name of ['a-account.txt', 'b-admin.txt', 'c-chat.txt']) {
        await writeFile(join(sourceDir, name), `Title ${name}\n\nBody of ${name}\n`)
    }
})

afterEach(async () => {
    kb.articles = 0
    kb.created.length = 0
    kb.hold = false
    for (const release of kb.held.splice(0)) release()
    kb.signals.length = 0
    if (hasRedis) await admin.del(KB_INIT_LOCK_KEY)
})

afterAll(async () => {
    if (!hasRedis) return
    await rm(sourceDir, { recursive: true, force: true })
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('knowledge-base init runs once (feat-115)', () => {
    it('two start() calls in one process: one import', async () => {
        const service = instance()

        const results = await Promise.all([service.start(), service.start()])

        expect(results.map((result) => result.ok).sort()).toEqual([false, true])
        expect(results.find((result) => !result.ok)).toMatchObject({ errorCode: 'ALREADY_RUNNING' })
        await service.running
        expect(kb.created).toHaveLength(3)
        expect(service.getStatus()).toMatchObject({ state: 'completed', createdArticles: 3 })
        // Released at the end: the key is gone.
        expect(await admin.exists(KB_INIT_LOCK_KEY)).toBe(0)
    })

    it('two instances: one gets the lock, the other is refused', async () => {
        const first = instance()
        const second = instance()

        const [a, b] = await Promise.all([first.start(), second.start()])

        expect([a.ok, b.ok].sort()).toEqual([false, true])
        const refused = a.ok ? second : first
        expect((a.ok ? b : a) as unknown).toMatchObject({ errorCode: 'ALREADY_RUNNING' })
        // The refused instance did not stay "running".
        expect(refused.getStatus().state).toBe('idle')
        await (a.ok ? first : second).running
        expect(kb.created).toHaveLength(3)
    })

    it('an early exit puts the state back, so a later start works', async () => {
        kb.articles = 1
        const service = instance()

        expect(await service.start()).toMatchObject({ ok: false, errorCode: 'NOT_EMPTY' })
        expect(service.getStatus().state).toBe('idle')
        expect(await admin.exists(KB_INIT_LOCK_KEY)).toBe(0)

        kb.articles = 0
        expect((await service.start()).ok).toBe(true)
        await service.running
        expect(kb.created).toHaveLength(3)
    })

    it('a lost lease: the late holder cannot renew or delete the new lock, and stops indexing', async () => {
        kb.hold = true
        const late = instance({ ttlMs: 400, renewEveryMs: 100, maxLifetimeMs: 60_000 })
        expect((await late.start()).ok).toBe(true)
        await until(() => kb.held.length === 1)
        // feat-125: every article went in with one statement before the first provider call.
        expect(kb.created).toHaveLength(3)

        // The lease expires (the process stalled past the TTL) and another instance takes it.
        await admin.del(KB_INIT_LOCK_KEY)
        await admin.set(KB_INIT_LOCK_KEY, 'other-instance', 'PX', 60_000)

        // The late holder's renewal finds another token: it learns it lost the lock and does not
        // move the new holder's TTL; the indexing in flight is cancelled by the lease signal.
        await late.running
        expect(await admin.pttl(KB_INIT_LOCK_KEY)).toBeGreaterThan(30_000)
        expect(kb.signals[0]?.aborted).toBe(true)
        expect(late.getStatus()).toMatchObject({
            state: 'failed',
            createdArticles: 3,
            processedFiles: 0,
        })
        expect(late.getStatus().message).toContain('lock lost')
        expect(late.getStatus().message).toContain('reindex-all')

        // The base is complete, not partial: a later init finds it not empty, and no article is
        // imported twice.
        await admin.del(KB_INIT_LOCK_KEY)
        expect(await instance().start()).toMatchObject({ ok: false, errorCode: 'NOT_EMPTY' })
        expect(kb.created).toHaveLength(3)
    })

    // feat-125: all or nothing. A lease lost before the insert leaves no article, so a later
    // init is not refused as NOT_EMPTY.
    it('a lease lost before the insert creates nothing, and a later init runs', async () => {
        let readDir: () => void = () => undefined
        const late = createKnowledgeBaseInitService({
            lease: { ttlMs: 400, renewEveryMs: 100, maxLifetimeMs: 60_000 },
            resolveSourceDir: () =>
                new Promise<string>((resolve) => {
                    readDir = () => {
                        resolve(sourceDir)
                    }
                }),
            delayMs: 0,
        })
        expect((await late.start()).ok).toBe(true)
        await admin.set(KB_INIT_LOCK_KEY, 'other-instance', 'PX', 60_000)
        await sleep(250)
        readDir()
        await late.running

        expect(late.getStatus()).toMatchObject({ state: 'failed', createdArticles: 0 })
        expect(kb.created).toHaveLength(0)

        await admin.del(KB_INIT_LOCK_KEY)
        const next = instance()
        expect((await next.start()).ok).toBe(true)
        await next.running
        expect(kb.created).toHaveLength(3)
    })

    it('a late release does not delete the lock of the new holder', async () => {
        kb.hold = true
        const late = instance({ ttlMs: 400, renewEveryMs: 100, maxLifetimeMs: 60_000 })
        expect((await late.start()).ok).toBe(true)
        await until(() => kb.held.length === 1)

        await admin.del(KB_INIT_LOCK_KEY)
        await admin.set(KB_INIT_LOCK_KEY, 'other-instance', 'PX', 60_000)

        kb.hold = false
        for (const release of kb.held.splice(0)) release()
        await late.running

        expect(await admin.get(KB_INIT_LOCK_KEY)).toBe('other-instance')
    })
})
