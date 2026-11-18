import { describe, expect, it } from 'vitest'

import { categoryOf, defineJob, type JobDefinition, type Outcome } from './job.js'

const base: JobDefinition = {
    name: 'test-job',
    schedule: { every: '15m' },
    timeout: '5m',
    run: () => Promise.resolve({ matched: 0, changed: 0 }),
}

describe('defineJob', () => {
    it('keeps the definition and adds the timeout in ms', () => {
        const job = defineJob(base)

        expect(job.name).toBe('test-job')
        expect(job.timeoutMs).toBe(5 * 60_000)
        expect(Object.isFrozen(job)).toBe(true)
    })

    it.each(['TestJob', 'test_job', 'test job', '-test', 'test-', ''])(
        'refuses the name %j',
        (name) => {
            expect(() => defineJob({ ...base, name })).toThrow('kebab-case')
        },
    )

    it('refuses an invalid schedule, naming the job', () => {
        expect(() => defineJob({ ...base, schedule: { every: '7m' } })).toThrow(
            'Job "test-job": every: "7m"',
        )
        expect(() => defineJob({ ...base, schedule: { dailyAt: '24:00' } })).toThrow('"24:00"')
    })

    it('refuses an invalid timeout', () => {
        expect(() => defineJob({ ...base, timeout: '5' })).toThrow('Job "test-job" timeout')
        expect(() => defineJob({ ...base, timeout: '0m' })).toThrow('"0m"')
    })
})

describe('categoryOf', () => {
    it.each<[Outcome, string]>([
        ['ok', 'success'],
        ['failed', 'failure'],
        ['timeout', 'aborted'],
        ['lease-lost', 'aborted'],
        ['shutdown', 'aborted'],
        ['skipped-locked', 'skipped'],
        ['skipped-backoff', 'skipped'],
    ])('%s is %s', (outcome, category) => {
        expect(categoryOf(outcome)).toBe(category)
    })
})
