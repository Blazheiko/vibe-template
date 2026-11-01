import { describe, expect, it } from 'vitest'

import { planPurge } from './purge-llm-prompts-args.js'

const NOW = new Date('2026-11-01T12:00:00.000Z')
const DAY = 86_400_000

// What `llm:purge-prompts` does follows the setting: with prompts not kept, anything that is
// still in the table is a leftover and goes; with them kept, only what is past the retention.
describe('planPurge', () => {
    it('purges everything when prompts are not kept (a leftover from before, or from a switch-off)', () => {
        expect(planPurge([], { storePrompts: false, retentionDays: 30 }, NOW)).toEqual({
            olderThan: null,
            dryRun: false,
        })
    })

    it('purges what is past the retention when prompts are kept', () => {
        expect(planPurge([], { storePrompts: true, retentionDays: 30 }, NOW)).toEqual({
            olderThan: new Date(NOW.getTime() - 30 * DAY),
            dryRun: false,
        })
    })

    it('--all purges everything whatever the setting', () => {
        expect(planPurge(['--all'], { storePrompts: true, retentionDays: 30 }, NOW)).toEqual({
            olderThan: null,
            dryRun: false,
        })
    })

    it('--dry-run changes nothing and combines with the others', () => {
        expect(planPurge(['--dry-run'], { storePrompts: true, retentionDays: 7 }, NOW)).toEqual({
            olderThan: new Date(NOW.getTime() - 7 * DAY),
            dryRun: true,
        })
        expect(
            planPurge(['--all', '--dry-run'], { storePrompts: true, retentionDays: 7 }, NOW),
        ).toEqual({ olderThan: null, dryRun: true })
    })

    it('--days overrides the retention', () => {
        expect(planPurge(['--days=3'], { storePrompts: true, retentionDays: 30 }, NOW)).toEqual({
            olderThan: new Date(NOW.getTime() - 3 * DAY),
            dryRun: false,
        })
    })

    it.each([['--days=0'], ['--days=-1'], ['--days=x'], ['--days='], ['--days=1.5'], ['--oops']])(
        'refuses %s instead of guessing (a purge cannot be undone)',
        (arg) => {
            expect(() => planPurge([arg], { storePrompts: true, retentionDays: 30 }, NOW)).toThrow()
        },
    )
})
