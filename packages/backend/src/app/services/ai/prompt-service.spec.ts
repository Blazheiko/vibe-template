import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Prompt cache with a TTL (code-issues item 43): a stale read returns the cached
// value at once and refreshes in the background; update() on this instance is
// visible immediately.
const findAll = vi.fn()
const findByType = vi.fn()
const update = vi.fn()
const lockByType = vi.fn()
vi.mock('#app/repositories/index.js', () => ({
    promptRepository: { findAll, findByType, update, lockByType },
    withTransaction: (work: (tx: unknown) => Promise<unknown>) => work({}),
}))
// feat-235: the audit write itself is covered by prompt-audit.pg.test.ts.
vi.mock('#app/services/audit/audit-service.js', () => ({
    auditService: {
        stamp: vi.fn(() => Promise.resolve({ occurredAt: '2026-11-20 00:00:00' })),
        record: vi.fn(() => Promise.resolve([])),
        logCommitted: vi.fn(),
    },
}))
const actor = { kind: 'user', userId: 1n, logger: { info: vi.fn() } } as never
vi.mock('#config/ai.js', () => ({ default: { promptCacheTtlMs: 60_000 } }))
const warn = vi.fn()
vi.mock('#logger', () => ({ default: { info: vi.fn(), warn, error: vi.fn() } }))

const row = (content: string) => ({ id: 1n, type: 'SUPPORT_SYSTEM', content })

beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
})

afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
})

const load = async () => {
    const { promptService } = await import('./prompt-service.js')
    findAll.mockResolvedValueOnce([row('v1')])
    await promptService.load()
    return promptService
}

describe('promptService cache TTL', () => {
    it('serves the cache without database reads while fresh', async () => {
        const promptService = await load()
        vi.advanceTimersByTime(59_000)
        expect(promptService.getContent('SUPPORT_SYSTEM')).toBe('v1')
        expect(findAll).toHaveBeenCalledTimes(1)
    })

    it('after the TTL returns the cached value and picks up the new one in the background', async () => {
        const promptService = await load()
        findAll.mockResolvedValueOnce([row('v2')])
        vi.advanceTimersByTime(60_001)

        expect(promptService.getContent('SUPPORT_SYSTEM')).toBe('v1')
        await vi.waitFor(() => {
            expect(promptService.getContent('SUPPORT_SYSTEM')).toBe('v2')
        })
        expect(findAll).toHaveBeenCalledTimes(2)
    })

    it('runs one refresh at a time', async () => {
        const promptService = await load()
        let finish: (rows: unknown[]) => void = () => {}
        findAll.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
        vi.advanceTimersByTime(60_001)

        promptService.get('SUPPORT_SYSTEM')
        promptService.get('SUPPORT_SYSTEM')
        promptService.getModel('SUPPORT_SYSTEM')
        expect(findAll).toHaveBeenCalledTimes(2)
        finish([row('v2')])
    })

    it('keeps the old values when the refresh fails', async () => {
        const promptService = await load()
        findAll.mockRejectedValueOnce(new Error('db down'))
        vi.advanceTimersByTime(60_001)

        promptService.get('SUPPORT_SYSTEM')
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalled()
        })
        expect(promptService.getContent('SUPPORT_SYSTEM')).toBe('v1')
    })

    it('update() is visible at once on this instance', async () => {
        const promptService = await load()
        lockByType.mockResolvedValue(row('v1'))
        update.mockResolvedValue(row('edited'))

        await promptService.update('SUPPORT_SYSTEM', { content: 'edited' }, actor)

        // The cached row is the one the UPDATE returned, not a second read.
        expect(findByType).not.toHaveBeenCalled()

        expect(promptService.getContent('SUPPORT_SYSTEM')).toBe('edited')
    })

    it('a background refresh that started before update() does not bring back the old row', async () => {
        const promptService = await load()
        let finishRefresh: (rows: unknown[]) => void = () => {}
        findAll.mockReturnValueOnce(
            new Promise((resolve) => {
                finishRefresh = resolve
            }),
        )
        vi.advanceTimersByTime(60_000)
        promptService.getContent('SUPPORT_SYSTEM') // starts the refresh, which reads 'v1'

        lockByType.mockResolvedValue(row('v1'))
        update.mockResolvedValue(row('edited'))
        await promptService.update('SUPPORT_SYSTEM', { content: 'edited' }, actor)
        finishRefresh([row('v1')])
        await vi.runAllTimersAsync()

        expect(promptService.getContent('SUPPORT_SYSTEM')).toBe('edited')
    })

    it('an update to the stored values runs no UPDATE', async () => {
        const promptService = await load()
        lockByType.mockResolvedValue({ ...row('v1'), temperature: 0.699999988079071 })

        expect(
            await promptService.update(
                'SUPPORT_SYSTEM',
                { content: 'v1', temperature: 0.7 },
                actor,
            ),
        ).toBe(true)

        expect(update).not.toHaveBeenCalled()
    })

    it('a prompt that does not exist is not updated', async () => {
        const promptService = await load()
        lockByType.mockResolvedValue(undefined)

        expect(await promptService.update('SUPPORT_SYSTEM', { content: 'x' }, actor)).toBe(false)
        expect(update).not.toHaveBeenCalled()
    })
})
