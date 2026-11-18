import { describe, expect, it } from 'vitest'

import { readSchedulerConfig } from './scheduler.js'

describe('scheduler config', () => {
    it('defaults: on, a 30 s tick, nothing disabled', () => {
        expect(readSchedulerConfig({})).toEqual({
            enabled: true,
            tickMs: 30_000,
            disabledJobs: [],
            configError: null,
        })
    })

    it('reads the variables', () => {
        expect(
            readSchedulerConfig({
                SCHEDULER_ENABLED: 'false',
                SCHEDULER_TICK: '1m',
                SCHEDULER_DISABLED_JOBS: ' auth-token-cleanup , llm-prompt-retention,',
            }),
        ).toEqual({
            enabled: false,
            tickMs: 60_000,
            disabledJobs: ['auth-token-cleanup', 'llm-prompt-retention'],
            configError: null,
        })
    })

    it.each([
        [{ SCHEDULER_ENABLED: 'maybe' }, 'SCHEDULER_ENABLED'],
        [{ SCHEDULER_TICK: '30' }, 'SCHEDULER_TICK: "30"'],
        [{ SCHEDULER_TICK: '4s' }, 'from 5s to 5m, got "4s"'],
        [{ SCHEDULER_TICK: '6m' }, 'from 5s to 5m, got "6m"'],
        [{ SCHEDULER_DISABLED_JOBS: 'Auth_Cleanup' }, '"Auth_Cleanup"'],
    ])('reports %j', (source, message) => {
        expect(readSchedulerConfig(source).configError).toContain(message)
    })

    it('accepts the bounds of the tick', () => {
        expect(readSchedulerConfig({ SCHEDULER_TICK: '5s' }).tickMs).toBe(5_000)
        expect(readSchedulerConfig({ SCHEDULER_TICK: '5m' }).tickMs).toBe(300_000)
    })
})
