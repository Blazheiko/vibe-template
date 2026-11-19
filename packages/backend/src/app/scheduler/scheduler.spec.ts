import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { HeldLease } from '#app/services/shared/redis-lease.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'

import { defineJob, type Job, type JobContext, type JobResult, type Outcome } from './job.js'
import { JobLeaseLostError, JobTimeoutError, type WithJobLease } from './job-lease.js'
import { createScheduler, type SchedulerDeps } from './scheduler.js'
import { backoffDelay, type JobState, type SchedulerState } from './scheduler-state.js'

// feat-222 (scheduler plan Р3–Р8, Р10): the core on a fake clock with a fake lease and a fake
// state store. The same flows on a real Redis are in scheduler.redis.test.ts.

const MINUTE = 60_000
const T0 = Date.parse('2026-11-18T03:05:00Z')

interface FakeLease extends Omit<HeldLease, 'release' | 'abandon'> {
    release: Mock<() => Promise<boolean>>
    abandon: Mock<() => void>
    released: boolean
    abandoned: boolean
    loseIt(): void
    timeOut(): void
}

/** An in-memory lease registry: a key stays held after abandon(), as a key with a TTL would. */
function fakeLeases() {
    const held = new Set<string>()
    const taken: FakeLease[] = []
    let unavailable = false
    const withLease = vi.fn<WithJobLease>(async ({ name, timeoutMs, signal }, fn) => {
        if (unavailable) throw new RedisUnavailableError()
        if (held.has(name)) return { status: 'busy' }
        held.add(name)
        const lost = new AbortController()
        const timeout = new AbortController()
        const lease: FakeLease = {
            lost: lost.signal,
            released: false,
            abandoned: false,
            release: vi.fn(() => {
                if (lease.abandoned || lease.released) return Promise.resolve(false)
                lease.released = true
                held.delete(name)
                return Promise.resolve(true)
            }),
            abandon: vi.fn(() => {
                lease.abandoned = true
            }),
            checkpoint: () => {
                lost.signal.throwIfAborted()
            },
            evalAsOwner: vi.fn(),
            loseIt: () => {
                lost.abort(new JobLeaseLostError('test'))
            },
            timeOut: () => {
                timeout.abort(new JobTimeoutError(timeoutMs))
            },
        }
        taken.push(lease)
        const any = AbortSignal.any([
            lost.signal,
            timeout.signal,
            ...(signal === undefined ? [] : [signal]),
        ])
        const checkpoint = (): void => {
            any.throwIfAborted()
            lease.checkpoint()
        }
        try {
            return {
                status: 'done',
                value: await fn({ lease, signal: any, checkpoint }),
                signal: any,
            }
        } finally {
            await lease.release()
        }
    })
    return {
        withLease,
        held,
        taken,
        last: (): FakeLease => {
            const lease = taken.at(-1)
            if (lease === undefined) throw new Error('no lease taken')
            return lease
        },
        setUnavailable: (value: boolean): void => {
            unavailable = value
        },
    }
}

function fakeState(clockNow: () => number) {
    const hashes = new Map<string, JobState>()
    const behaviour = { notOwner: false, throwOnWrite: false }
    const get = (job: string): JobState => hashes.get(job) ?? { consecutiveFailures: 0 }
    const state = {
        read: vi.fn((job: string) => Promise.resolve({ ...get(job) })),
        recordSuccess: vi.fn((_lease: HeldLease, job: string, { slot }: { slot: number }) => {
            if (behaviour.throwOnWrite) return Promise.reject(new RedisUnavailableError())
            if (behaviour.notOwner) return Promise.resolve({ status: 'not-owner' as const })
            const current = get(job)
            const next: JobState = {
                ...current,
                lastSuccessSlot: Math.max(current.lastSuccessSlot ?? 0, slot),
                consecutiveFailures: 0,
                lastOutcome: 'ok',
            }
            delete next.nextRetryAt
            hashes.set(job, next)
            return Promise.resolve({ status: 'written' as const })
        }),
        recordFailure: vi.fn(
            (
                _lease: HeldLease,
                job: string,
                { outcome, maxBackoffMs }: { outcome: string; maxBackoffMs: number },
            ) => {
                if (behaviour.throwOnWrite) return Promise.reject(new RedisUnavailableError())
                if (behaviour.notOwner) return Promise.resolve({ status: 'not-owner' as const })
                const current = get(job)
                const failures = current.consecutiveFailures + 1
                const nextRetryAt = clockNow() + backoffDelay(failures, maxBackoffMs)
                hashes.set(job, {
                    ...current,
                    consecutiveFailures: failures,
                    nextRetryAt,
                    lastOutcome: outcome,
                })
                return Promise.resolve({ status: 'written' as const, nextRetryAt })
            },
        ),
    } satisfies SchedulerState
    return { state, hashes, behaviour }
}

/** Records every entry in order, whatever its level. */
const silentLogger = () => {
    const entries: object[] = []
    const level = () =>
        vi.fn((entry: object) => {
            entries.push(entry)
        })
    return { entries, info: level(), warn: level(), error: level() }
}

type Run = (ctx: JobContext) => Promise<JobResult>
const counts = (matched = 0, changed = 0): Promise<JobResult> =>
    Promise.resolve({ matched, changed })

const job = (name: string, run: Run, schedule: Job['schedule'] = { every: '15m' }): Job =>
    defineJob({ name, schedule, timeout: '5m', run })

function setup(jobs: Job[], extra: Partial<SchedulerDeps> = {}) {
    let now = T0
    const clock = { now: (): number => now }
    const leases = fakeLeases()
    const store = fakeState(clock.now)
    const logger = silentLogger()
    const sentry = { captureException: vi.fn() }
    const scheduler = createScheduler({
        jobs,
        clock,
        // vi.fn loses the generic parameter of WithJobLease.
        withLease: leases.withLease as unknown as WithJobLease,
        state: store.state,
        logger,
        sentry,
        tickMs: 30_000,
        stopDrainMs: 50,
        ...extra,
    })
    const outcomes = (): Outcome[] =>
        logger.entries
            .map((entry) => (entry as { outcome?: Outcome }).outcome)
            .filter((outcome): outcome is Outcome => outcome !== undefined)
    return {
        scheduler,
        leases,
        store,
        logger,
        sentry,
        outcomes,
        advance: (ms: number): void => {
            now += ms
        },
        setNow: (value: number): void => {
            now = value
        },
    }
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('due check', () => {
    it('runs at once on the first start, then not again in the same slot', async () => {
        const run = vi.fn(() => counts(3, 3))
        const t = setup([job('a', run)])

        await t.scheduler.tick()
        t.advance(MINUTE)
        await t.scheduler.tick()

        expect(run).toHaveBeenCalledTimes(1)
        expect(t.store.hashes.get('a')?.lastSuccessSlot).toBe(Date.parse('2026-11-18T03:00:00Z'))
    })

    it('runs again in the next slot', async () => {
        const run = vi.fn(() => counts())
        const t = setup([job('a', run)])

        await t.scheduler.tick()
        t.advance(15 * MINUTE)
        await t.scheduler.tick()

        expect(run).toHaveBeenCalledTimes(2)
    })

    it('collapses missed slots into one run', async () => {
        const run = vi.fn(() => counts())
        const t = setup([job('daily', run, { dailyAt: '03:00' })])
        t.store.hashes.set('daily', {
            consecutiveFailures: 0,
            lastSuccessSlot: Date.parse('2026-11-15T03:00:00Z'),
        })

        await t.scheduler.tick()
        await t.scheduler.tick()

        expect(run).toHaveBeenCalledTimes(1)
        expect(t.store.hashes.get('daily')?.lastSuccessSlot).toBe(
            Date.parse('2026-11-18T03:00:00Z'),
        )
    })

    it('does not run a slot another replica already ran', async () => {
        const run = vi.fn(() => counts())
        const t = setup([job('a', run)])
        t.store.hashes.set('a', {
            consecutiveFailures: 0,
            lastSuccessSlot: Date.parse('2026-11-18T03:00:00Z'),
        })

        await t.scheduler.tick()

        expect(run).not.toHaveBeenCalled()
        // The lease was taken for the check and given back.
        expect(t.leases.held.size).toBe(0)
    })

    it('passes the slot, a dry-run flag and the checkpoint to the job', async () => {
        let seen: JobContext | undefined
        const t = setup([
            job('a', (ctx) => {
                seen = ctx
                ctx.checkpoint()
                return counts()
            }),
        ])

        await t.scheduler.tick()

        expect(seen?.slot).toBe(Date.parse('2026-11-18T03:00:00Z'))
        expect(seen?.dryRun).toBe(false)
        expect(seen?.signal.aborted).toBe(false)
    })
})

describe('backoff', () => {
    it('grows after each failure, caps at the maximum and is reset by a success', async () => {
        let fail = true
        const run = vi.fn(() => (fail ? Promise.reject(new Error('boom')) : counts()))
        // every 15m: the backoff is at most 15 minutes.
        const t = setup([job('a', run)])
        const delays: number[] = []
        let tickedAt = T0

        for (let i = 0; i < 6; i += 1) {
            await t.scheduler.tick()
            const nextRetryAt = t.store.hashes.get('a')?.nextRetryAt ?? 0
            delays.push((nextRetryAt - tickedAt) / MINUTE)
            tickedAt = nextRetryAt
            t.setNow(nextRetryAt)
        }

        expect(delays).toEqual([1, 2, 4, 8, 15, 15])
        fail = false
        await t.scheduler.tick()
        expect(t.store.hashes.get('a')?.consecutiveFailures).toBe(0)
        expect(t.store.hashes.get('a')?.nextRetryAt).toBeUndefined()
    })

    it('skips without touching Redis while the local backoff lasts', async () => {
        const t = setup([job('a', () => Promise.reject(new Error('boom')))])

        await t.scheduler.tick()
        t.leases.withLease.mockClear()
        t.advance(30_000)
        await t.scheduler.tick()

        expect(t.leases.withLease).not.toHaveBeenCalled()
        expect(t.outcomes()).toEqual(['failed', 'skipped-backoff'])
    })

    it('follows a backoff another replica wrote', async () => {
        const run = vi.fn(() => counts())
        const t = setup([job('a', run)])
        t.store.hashes.set('a', { consecutiveFailures: 1, nextRetryAt: T0 + MINUTE })

        await t.scheduler.tick()

        expect(run).not.toHaveBeenCalled()
        expect(t.outcomes()).toEqual(['skipped-backoff'])
    })

    it('a success the owner check refused is lease-lost, held back locally', async () => {
        const run = vi.fn(() => counts())
        const t = setup([job('a', run)])
        t.store.behaviour.notOwner = true

        await t.scheduler.tick()
        t.advance(30_000)
        await t.scheduler.tick()

        expect(run).toHaveBeenCalledTimes(1)
        expect(t.outcomes()).toEqual(['lease-lost', 'skipped-backoff'])
        expect(t.store.hashes.get('a')).toBeUndefined()
    })

    it('a failure the owner check refused is lease-lost, held back locally', async () => {
        const t = setup([job('a', () => Promise.reject(new Error('boom')))])
        t.store.behaviour.notOwner = true

        await t.scheduler.tick()
        t.advance(30_000)
        await t.scheduler.tick()

        expect(t.outcomes()).toEqual(['lease-lost', 'skipped-backoff'])
    })

    it('a state write Redis refused is held back locally and repeated later', async () => {
        const run = vi.fn(() => counts(2, 2))
        const t = setup([job('a', run)])
        t.store.behaviour.throwOnWrite = true

        await t.scheduler.tick()
        t.advance(30_000)
        await t.scheduler.tick()
        expect(run).toHaveBeenCalledTimes(1)

        t.store.behaviour.throwOnWrite = false
        t.advance(MINUTE)
        await t.scheduler.tick()
        expect(run).toHaveBeenCalledTimes(2)
    })
})

describe('outcomes of an aborted run', () => {
    it('a run that returns after its timeout is a timeout, not a success', async () => {
        const t = setup([
            job('a', () => {
                t.leases.last().timeOut()
                return counts(1, 1)
            }),
        ])

        await t.scheduler.tick()

        expect(t.outcomes()).toEqual(['timeout'])
        expect(t.store.state.recordSuccess).not.toHaveBeenCalled()
        expect(t.store.state.recordFailure).toHaveBeenCalledTimes(1)
    })

    it('a run whose lease was lost writes no state', async () => {
        const t = setup([
            job('a', (ctx) => {
                t.leases.last().loseIt()
                ctx.checkpoint()
                return counts()
            }),
        ])

        await t.scheduler.tick()

        expect(t.outcomes()).toEqual(['lease-lost'])
        expect(t.store.state.recordSuccess).not.toHaveBeenCalled()
        expect(t.store.state.recordFailure).not.toHaveBeenCalled()
    })

    it('a run stopped by stop() is a shutdown and writes no state', async () => {
        let started: () => void = () => undefined
        const running = new Promise<void>((resolve) => (started = resolve))
        const t = setup([
            job(
                'a',
                (ctx) =>
                    new Promise((resolve) => {
                        started()
                        ctx.signal.addEventListener('abort', () => {
                            resolve({ matched: 1, changed: 1 })
                        })
                    }),
            ),
        ])

        const tick = t.scheduler.tick()
        await running
        await t.scheduler.stop()
        await tick

        expect(t.outcomes()).toEqual(['shutdown'])
        expect(t.store.state.recordSuccess).not.toHaveBeenCalled()
        expect(t.store.state.recordFailure).not.toHaveBeenCalled()
    })
})

describe('stop()', () => {
    const blockingJob = (onStart: () => void, gate: Promise<void>, obeys: boolean): Job =>
        job('slow', async (ctx) => {
            onStart()
            await (obeys
                ? new Promise<void>((resolve) => {
                      ctx.signal.addEventListener('abort', () => {
                          resolve()
                      })
                  })
                : gate)
            return { matched: 0, changed: 0 }
        })

    it('releases the lease when the job ends within the drain', async () => {
        let started: () => void = () => undefined
        const running = new Promise<void>((resolve) => (started = resolve))
        const t = setup([blockingJob(started, Promise.resolve(), true)])

        const tick = t.scheduler.tick()
        await running
        await t.scheduler.stop()
        await tick

        const lease = t.leases.last()
        expect(lease.release).toHaveBeenCalled()
        expect(lease.abandon).not.toHaveBeenCalled()
        expect(t.leases.held.size).toBe(0)
    })

    it('abandons the lease when the job outlives the drain: the key stays to its TTL', async () => {
        let started: () => void = () => undefined
        const running = new Promise<void>((resolve) => (started = resolve))
        let finish: () => void = () => undefined
        const gate = new Promise<void>((resolve) => (finish = resolve))
        const t = setup([blockingJob(started, gate, false)])

        const tick = t.scheduler.tick()
        await running
        await t.scheduler.stop()

        // At the end of the drain: abandoned, not released.
        const lease = t.leases.last()
        expect(lease.abandon).toHaveBeenCalledTimes(1)
        expect(lease.release).not.toHaveBeenCalled()

        finish()
        await tick

        // The wrapper's release came after the abandon: a no-op, the key is still held.
        expect(lease.release).toHaveBeenCalledTimes(1)
        expect(t.leases.held.has('slow')).toBe(true)
    })

    it('does not throw when abandoning fails, and a second stop() is a no-op', async () => {
        let started: () => void = () => undefined
        const running = new Promise<void>((resolve) => (started = resolve))
        let finish: () => void = () => undefined
        const gate = new Promise<void>((resolve) => (finish = resolve))
        const t = setup([blockingJob(started, gate, false)])

        const tick = t.scheduler.tick()
        await running
        t.leases.last().abandon.mockImplementation(() => {
            throw new Error('Redis is gone')
        })

        await expect(t.scheduler.stop()).resolves.toBeUndefined()
        await expect(t.scheduler.stop()).resolves.toBeUndefined()
        finish()
        await tick
    })

    it('starts no new run after stop()', async () => {
        const run = vi.fn(() => counts())
        const t = setup([job('a', run)])

        await t.scheduler.stop()
        await t.scheduler.tick()

        expect(run).not.toHaveBeenCalled()
    })
})

describe('the loop', () => {
    it('runs jobs one at a time, in registry order', async () => {
        const events: string[] = []
        let finishFirst: () => void = () => undefined
        const firstGate = new Promise<void>((resolve) => (finishFirst = resolve))
        const t = setup([
            job('first', async () => {
                events.push('first:start')
                await firstGate
                events.push('first:end')
                return { matched: 0, changed: 0 }
            }),
            job('second', () => {
                events.push('second:start')
                return counts()
            }),
        ])

        const tick = t.scheduler.tick()
        await new Promise((resolve) => setImmediate(resolve))
        expect(events).toEqual(['first:start'])
        finishFirst()
        await tick

        expect(events).toEqual(['first:start', 'first:end', 'second:start'])
    })

    it('skips a disabled job without taking its lease', async () => {
        const off = vi.fn(() => counts())
        const on = vi.fn(() => counts())
        const t = setup([job('off', off), job('on', on)], { disabledJobs: ['off'] })

        await t.scheduler.tick()

        expect(off).not.toHaveBeenCalled()
        expect(on).toHaveBeenCalledTimes(1)
        expect(t.leases.withLease.mock.calls.map(([options]) => options.name)).toEqual(['on'])
    })

    it('reports a skipped-locked run when another replica holds the lease', async () => {
        const run = vi.fn(() => counts())
        const t = setup([job('a', run)])
        t.leases.held.add('a')

        await t.scheduler.tick()

        expect(run).not.toHaveBeenCalled()
        expect(t.outcomes()).toEqual(['skipped-locked'])
    })

    it('skips the rest of a tick with one warn when Redis is unavailable', async () => {
        const t = setup([job('a', () => counts()), job('b', () => counts())])
        t.leases.setUnavailable(true)

        await expect(t.scheduler.tick()).resolves.toBeUndefined()

        expect(t.logger.warn).toHaveBeenCalledTimes(1)
        expect(t.leases.withLease).toHaveBeenCalledTimes(1)
    })

    it('sleeps a jittered tick between passes and stops on stop()', async () => {
        const sleeps: number[] = []
        const run = vi.fn(() => counts())
        const t = setup([job('a', run)], {
            random: () => 1,
            sleep: (ms, signal) => {
                sleeps.push(ms)
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(new Error('aborted'))
                    })
                })
            },
        })

        t.scheduler.start()
        await new Promise((resolve) => setImmediate(resolve))
        await t.scheduler.stop()

        expect(run).toHaveBeenCalledTimes(1)
        expect(sleeps).toHaveLength(1)
        expect(sleeps[0]).toBeCloseTo(36_000)
    })
})

describe('Sentry', () => {
    it.each<[string, Run, Outcome, boolean]>([
        ['ok', () => counts(), 'ok', false],
        ['failed', () => Promise.reject(new Error('boom')), 'failed', true],
    ])('%s', async (_name, run, outcome, reported) => {
        const t = setup([job('a', run)])

        await t.scheduler.tick()

        expect(t.outcomes()).toEqual([outcome])
        expect(t.sentry.captureException).toHaveBeenCalledTimes(reported ? 1 : 0)
    })

    it('a timeout is reported with the job tag; a lost lease is not', async () => {
        const t = setup([
            job('times-out', () => {
                t.leases.last().timeOut()
                return counts()
            }),
            job('loses', () => {
                t.leases.last().loseIt()
                return counts()
            }),
        ])

        await t.scheduler.tick()

        expect(t.outcomes()).toEqual(['timeout', 'lease-lost'])
        expect(t.sentry.captureException).toHaveBeenCalledTimes(1)
        expect(t.sentry.captureException.mock.calls[0]?.[1]).toMatchObject({
            tags: { job: 'times-out', outcome: 'timeout' },
        })
    })
})

describe('runOnce', () => {
    const states = (t: ReturnType<typeof setup>): number =>
        t.store.state.read.mock.calls.length +
        t.store.state.recordSuccess.mock.calls.length +
        t.store.state.recordFailure.mock.calls.length

    it.each<[string, (t: ReturnType<typeof setup>) => Run, Outcome]>([
        ['ok', () => () => counts(4, 4), 'ok'],
        ['failed', () => () => Promise.reject(new Error('boom')), 'failed'],
        [
            'timeout',
            (t) => () => {
                t.leases.last().timeOut()
                return counts()
            },
            'timeout',
        ],
    ])('%s: neither reads nor writes the state', async (_name, makeRun, outcome) => {
        const holder: { run: Run } = { run: () => counts() }
        const t = setup([job('a', (ctx) => holder.run(ctx))])
        holder.run = makeRun(t)

        const result = await t.scheduler.runOnce('a')

        expect(result.outcome).toBe(outcome)
        expect(states(t)).toBe(0)
        expect(t.leases.held.size).toBe(0)
    })

    it('passes dryRun and reports matched and changed', async () => {
        const t = setup([job('a', (ctx) => counts(5, ctx.dryRun ? 0 : 5))])

        expect(await t.scheduler.runOnce('a', { dryRun: true })).toEqual({
            outcome: 'ok',
            matched: 5,
            changed: 0,
        })
    })

    it('a SIGINT signal ends it as a shutdown', async () => {
        const controller = new AbortController()
        const t = setup([
            job('a', () => {
                controller.abort(new Error('SIGINT'))
                return counts()
            }),
        ])

        const result = await t.scheduler.runOnce('a', { signal: controller.signal })

        expect(result.outcome).toBe('shutdown')
        expect(states(t)).toBe(0)
    })

    it('answers skipped-locked while the lease is held', async () => {
        const t = setup([job('a', () => counts())])
        t.leases.held.add('a')

        expect((await t.scheduler.runOnce('a')).outcome).toBe('skipped-locked')
    })

    it('runs a job disabled for the schedule, with a warning', async () => {
        const run = vi.fn(() => counts())
        const t = setup([job('a', run)], { disabledJobs: ['a'] })

        expect((await t.scheduler.runOnce('a')).outcome).toBe('ok')
        expect(t.logger.warn).toHaveBeenCalled()
    })

    it('refuses an unknown job', async () => {
        const t = setup([job('a', () => counts())])

        await expect(t.scheduler.runOnce('nope')).rejects.toThrow('Unknown job "nope"')
    })
})

describe('registry', () => {
    it('refuses two jobs with the same name', () => {
        expect(() => setup([job('a', () => counts()), job('a', () => counts())])).toThrow(
            'Duplicate job name "a"',
        )
    })
})

// Review of 0606f9a: three defects, each pinned by a test.
describe('review fixes', () => {
    it('a stop() while the state is read starts no run: shutdown', async () => {
        const run = vi.fn(() => counts())
        const holder: { stop?: () => Promise<void> } = {}
        const t = setup([job('a', run)])
        holder.stop = () => t.scheduler.stop()
        const read = t.store.state.read.getMockImplementation()
        t.store.state.read.mockImplementation(async (name: string) => {
            void holder.stop?.()
            return (await read?.(name)) ?? { consecutiveFailures: 0 }
        })

        await t.scheduler.tick()

        expect(run).not.toHaveBeenCalled()
        expect(t.outcomes()).toEqual(['shutdown'])
        expect(t.store.state.recordSuccess).not.toHaveBeenCalled()
    })

    it('runOnce with a signal aborted beforehand starts no run: shutdown', async () => {
        const run = vi.fn(() => counts())
        const t = setup([job('a', run)])
        const controller = new AbortController()
        controller.abort(new Error('SIGINT'))

        const result = await t.scheduler.runOnce('a', { signal: controller.signal })

        expect(run).not.toHaveBeenCalled()
        expect(result.outcome).toBe('shutdown')
    })

    it('a lease lost during the run holds the job back locally', async () => {
        const run = vi.fn(() => {
            t.leases.last().loseIt()
            return counts()
        })
        const t = setup([job('a', run)])

        await t.scheduler.tick()
        t.advance(30_000)
        await t.scheduler.tick()

        expect(run).toHaveBeenCalledTimes(1)
        expect(t.outcomes()).toEqual(['lease-lost', 'skipped-backoff'])
        expect(t.store.hashes.get('a')).toBeUndefined()
    })

    it('a success of another replica resets the local failure count', async () => {
        let fail = true
        const run = vi.fn(() => (fail ? Promise.reject(new Error('boom')) : counts()))
        const t = setup([job('a', run)])
        // A failure here whose state write Redis refused: held back 1m locally.
        t.store.behaviour.throwOnWrite = true
        await t.scheduler.tick()
        t.store.behaviour.throwOnWrite = false

        // Another replica succeeds in this slot; this process sees it after its backoff.
        t.advance(2 * MINUTE)
        t.store.hashes.set('a', {
            consecutiveFailures: 0,
            lastSuccessSlot: Date.parse('2026-11-18T03:00:00Z'),
            lastOutcome: 'ok',
            lastRunAt: T0 + MINUTE,
        })
        await t.scheduler.tick()

        // The next slot: the run succeeds but its write fails. A fresh first backoff, 1m, not 2m.
        fail = false
        t.setNow(Date.parse('2026-11-18T03:15:00Z'))
        t.store.behaviour.throwOnWrite = true
        await t.scheduler.tick()
        t.store.behaviour.throwOnWrite = false
        t.leases.withLease.mockClear()

        t.advance(MINUTE - 1)
        await t.scheduler.tick()
        expect(t.leases.withLease).not.toHaveBeenCalled()
        t.advance(2)
        await t.scheduler.tick()
        expect(t.leases.withLease).toHaveBeenCalledTimes(1)
    })
})

// feat-230: a run that rejects with undefined is a failure. The failure used to be told by
// `err !== undefined`, so `Promise.reject()` and `throw undefined` were recorded as successes.
describe('a run that rejects without a reason', () => {
    const rejections: [string, Run][] = [
        [
            'Promise.reject(undefined)',
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
            () => Promise.reject(undefined),
        ],
        [
            'throw undefined',
            async () => {
                await Promise.resolve()
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
                throw undefined
            },
        ],
    ]

    it.each(rejections)('%s is failed: backoff, Sentry, no success slot', async (_name, run) => {
        const t = setup([job('a', run)])

        await t.scheduler.tick()

        expect(t.outcomes()).toEqual(['failed'])
        expect(t.store.state.recordSuccess).not.toHaveBeenCalled()
        expect(t.store.hashes.get('a')?.lastSuccessSlot).toBeUndefined()
        expect(t.store.hashes.get('a')?.consecutiveFailures).toBe(1)
        expect(t.store.hashes.get('a')?.nextRetryAt).toBe(T0 + MINUTE)
        expect(t.sentry.captureException).toHaveBeenCalledTimes(1)
        expect(t.sentry.captureException.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    })

    it.each(rejections)('%s is failed in runOnce (job:run exits 1)', async (_name, run) => {
        const t = setup([job('a', run)])

        expect((await t.scheduler.runOnce('a')).outcome).toBe('failed')
    })
})
