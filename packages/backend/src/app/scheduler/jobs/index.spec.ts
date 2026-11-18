import { describe, expect, it } from 'vitest'

import { defineJob } from '../job.js'
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
