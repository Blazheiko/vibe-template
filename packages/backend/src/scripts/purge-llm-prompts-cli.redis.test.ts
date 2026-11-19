import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { cleanupTestRedis, createTestRedis, hasRedis } from '../test-support/redis-test-client.js'

// feat-224: `llm:purge-prompts` takes the lease of the llm-prompt-retention job on a real Redis.
// The purge itself is a fake here; the SQL is in llm-prompt-retention.pg.test.ts.

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
vi.mock('#logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { stop(): void }
}
const { jobLeaseKey, withJobLease } = await import('#app/scheduler/job-lease.js')
const { stateKey } = await import('#app/scheduler/scheduler-state.js')
const { EXIT_BUSY, EXIT_INTERRUPTED, runPromptPurge } = await import('./purge-llm-prompts-cli.js')

const admin = createTestRedis(PREFIX)
const plan = { olderThan: null, dryRun: false }
let n = 0

const setup = (purge: Parameters<typeof runPromptPurge>[1]['purge']) => {
    n += 1
    const job = { name: `prompt-purge-${String(n)}`, timeoutMs: 60_000 }
    const lines: string[] = []
    const controller = new AbortController()
    const deps = {
        job,
        withLease: withJobLease,
        purge,
        signal: controller.signal,
        print: (line: string) => lines.push(line),
        printError: (line: string) => lines.push(line),
    }
    return { job, lines, controller, deps }
}

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('llm:purge-prompts under the job lease', () => {
    it('purges under the lease, frees it after and leaves the schedule state alone', async () => {
        let heldDuringRun = 0
        const t = setup(async () => {
            heldDuringRun = await admin.exists(jobLeaseKey(t.job.name))
            return { matched: 3, changed: 3 }
        })

        expect(await runPromptPurge(plan, t.deps)).toBe(0)

        expect(heldDuringRun).toBe(1)
        expect(await admin.exists(jobLeaseKey(t.job.name))).toBe(0)
        expect(await admin.exists(stateKey(t.job.name))).toBe(0)
        expect(t.lines).toEqual(['Emptied 3 row(s) of all stored prompt text.'])
    })

    it('answers busy with 75 while the scheduled run holds the lease, purging nothing', async () => {
        const purge = vi.fn(() => Promise.resolve({ matched: 0, changed: 0 }))
        const t = setup(purge)

        const code = await withJobLease({ name: t.job.name, timeoutMs: 60_000 }, () =>
            runPromptPurge(plan, t.deps),
        )

        expect(code).toEqual({ status: 'done', value: EXIT_BUSY, signal: expect.anything() })
        expect(purge).not.toHaveBeenCalled()
        expect(t.lines[0]).toMatch(/^Busy: /)
    })

    it('frees the lease when the purge fails, and the error goes to the caller (exit 1)', async () => {
        const t = setup(() => Promise.reject(new Error('database down')))

        await expect(runPromptPurge(plan, t.deps)).rejects.toThrow('database down')

        expect(await admin.exists(jobLeaseKey(t.job.name))).toBe(0)
    })

    it('ends with 130 when interrupted, and passes the lease checkpoint to the purge', async () => {
        const t = setup(({ checkpoint }) => {
            t.controller.abort(new Error('interrupted'))
            checkpoint()
            return Promise.resolve({ matched: 0, changed: 0 })
        })

        expect(await runPromptPurge(plan, t.deps)).toBe(EXIT_INTERRUPTED)
        expect(await admin.exists(jobLeaseKey(t.job.name))).toBe(0)
    })
})
