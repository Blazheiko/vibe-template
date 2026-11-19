import { describe, expect, it } from 'vitest'

import { DATABASE_WRITE_BOUND_MS } from '#app/services/shared/redis-lease.js'

import { defineJob } from '../job.js'
import { leaseForJob } from '../job-lease.js'
import { jobs, resolveDisabledJobs } from './index.js'

const sample = defineJob({
    name: 'sample-job',
    schedule: { every: '1h' },
    timeout: '1m',
    run: () => Promise.resolve({ matched: 0, changed: 0 }),
})

describe('job registry', () => {
    it('has unique names', () => {
        const names = jobs.map((job) => job.name)
        expect(new Set(names).size).toBe(names.length)
    })

    it('contains the auth token cleanup (feat-223) and the prompt retention (feat-224)', () => {
        expect(jobs.map((job) => job.name)).toEqual(['auth-token-cleanup', 'llm-prompt-retention'])
    })

    // Р13: a job that runs into its timeout must end with `timeout`, not with a lost lease.
    it.each(jobs.map((job) => [job.name, job] as const))(
        'gives %s a lease that outlives its timeout and the longest write',
        (_name, job) => {
            expect(leaseForJob(job.timeoutMs).maxLifetimeMs).toBeGreaterThan(
                job.timeoutMs + DATABASE_WRITE_BOUND_MS,
            )
        },
    )

    it('accepts disabled names of registered jobs', () => {
        expect(resolveDisabledJobs(['sample-job'], [sample])).toEqual(['sample-job'])
        expect(resolveDisabledJobs([], [])).toEqual([])
    })

    it('stops the startup on an unknown disabled name', () => {
        expect(() => resolveDisabledJobs(['sample-jbo'], [sample])).toThrow(
            'SCHEDULER_DISABLED_JOBS names unknown job(s) "sample-jbo"',
        )
    })
})
