import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-222 (scheduler plan Р13): the lease parameters of a job, and a job that runs into its
// timeout ends with a timeout, not with a lost lease. Redis is mocked; the real-Redis behaviour
// of withJobLease is in job-lease.redis.test.ts.

const { redisMock, loggerMock } = vi.hoisted(() => ({
    redisMock: { set: vi.fn(), eval: vi.fn() },
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('#logger', () => ({ default: loggerMock }))

vi.mock('#database/redis.js', () => ({
    default: redisMock,
    withRedis: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}))

const { DATABASE_WRITE_BOUND_MS } = await import('#app/services/shared/redis-lease.js')
const { leaseForJob, withJobLease, JobTimeoutError, JOB_LEASE_RENEW_EVERY_MS } =
    await import('./job-lease.js')

const MINUTE = 60_000

describe('leaseForJob', () => {
    it.each([1, 5, 10, 60].map((minutes) => minutes * MINUTE))(
        'outlives a timeout of %i ms by more than the longest write',
        (timeoutMs) => {
            const lease = leaseForJob(timeoutMs)

            expect(lease.maxLifetimeMs).toBeGreaterThan(timeoutMs + DATABASE_WRITE_BOUND_MS)
            expect(lease.ttlMs).toBeGreaterThanOrEqual(
                DATABASE_WRITE_BOUND_MS + 1000 + 2 * lease.renewEveryMs,
            )
            expect(lease.renewEveryMs).toBe(JOB_LEASE_RENEW_EVERY_MS)
        },
    )
})

describe('withJobLease under fake timers', () => {
    beforeEach(() => {
        vi.useFakeTimers({
            toFake: [
                'setTimeout',
                'clearTimeout',
                'setInterval',
                'clearInterval',
                'Date',
                'performance',
            ],
        })
        redisMock.set.mockResolvedValue('OK')
        redisMock.eval.mockResolvedValue(1)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.clearAllMocks()
    })

    it('aborts a job that runs into its timeout with a timeout, the lease still held', async () => {
        const timeoutMs = 5 * MINUTE
        let leaseLost: boolean | undefined
        const running = withJobLease({ name: 'slow', timeoutMs }, async ({ signal, lease }) => {
            await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => {
                    resolve()
                })
            })
            leaseLost = lease.lost.aborted
            return signal.reason as unknown
        })

        await vi.advanceTimersByTimeAsync(timeoutMs + 10)
        const result = await running

        expect(result.status).toBe('done')
        if (result.status !== 'done') return
        expect(result.value).toBeInstanceOf(JobTimeoutError)
        expect(leaseLost).toBe(false)
    })

    it('does not call fn when the lease is held elsewhere', async () => {
        redisMock.set.mockResolvedValue(null)
        const fn = vi.fn()

        expect(await withJobLease({ name: 'busy', timeoutMs: MINUTE }, fn)).toEqual({
            status: 'busy',
        })
        expect(fn).not.toHaveBeenCalled()
    })

    it('rethrows the error of fn after the release', async () => {
        await expect(
            withJobLease({ name: 'boom', timeoutMs: MINUTE }, () =>
                Promise.reject(new Error('boom')),
            ),
        ).rejects.toThrow('boom')
        // The release script ran.
        expect(redisMock.eval).toHaveBeenCalledTimes(1)
    })

    it('a failed release does not replace the result', async () => {
        redisMock.eval.mockRejectedValue(new Error('Redis is gone'))

        const result = await withJobLease({ name: 'ok', timeoutMs: MINUTE }, () =>
            Promise.resolve(42),
        )

        expect(result).toMatchObject({ status: 'done', value: 42 })
        expect(loggerMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({ job: 'ok' }),
            'Scheduler: the job lease could not be released',
        )
    })

    it('checkpoint throws once the caller signal is aborted', async () => {
        const caller = new AbortController()
        const result = await withJobLease(
            { name: 'stop', timeoutMs: MINUTE, signal: caller.signal },
            ({ checkpoint }) => {
                checkpoint()
                caller.abort(new Error('stop'))
                try {
                    checkpoint()
                    return Promise.resolve('not stopped')
                } catch (error: unknown) {
                    return Promise.resolve((error as Error).message)
                }
            },
        )

        expect(result).toMatchObject({ status: 'done', value: 'stop' })
    })
})
