import { describe, expect, it } from 'vitest'

import { exitCodeOf, parseRunJobArgs } from './run-job-args.js'

const known = ['auth-token-cleanup', 'llm-prompt-retention']

describe('parseRunJobArgs', () => {
    it('reads the name and --dry-run in any order', () => {
        expect(parseRunJobArgs(['auth-token-cleanup'], known)).toEqual({
            name: 'auth-token-cleanup',
            dryRun: false,
        })
        expect(parseRunJobArgs(['--dry-run', 'llm-prompt-retention'], known)).toEqual({
            name: 'llm-prompt-retention',
            dryRun: true,
        })
    })

    it.each([
        [[], 'No job name given'],
        [['--force', 'auth-token-cleanup'], 'Unknown argument "--force"'],
        [['auth-token-cleanup', 'llm-prompt-retention'], 'Only one job name'],
        [['no-such-job'], 'Unknown job "no-such-job". Jobs: auth-token-cleanup'],
    ])('refuses %j', (args, message) => {
        expect(() => parseRunJobArgs(args, known)).toThrow(message)
    })

    it('says when no job is registered', () => {
        expect(() => parseRunJobArgs(['x'], [])).toThrow('Jobs: none registered.')
    })
})

describe('exitCodeOf', () => {
    it('maps the outcomes to exit codes', () => {
        expect(exitCodeOf('ok')).toBe(0)
        expect(exitCodeOf('skipped-locked')).toBe(75)
        expect(exitCodeOf('shutdown')).toBe(130)
        expect(exitCodeOf('failed')).toBe(1)
        expect(exitCodeOf('timeout')).toBe(1)
        expect(exitCodeOf('lease-lost')).toBe(1)
    })
})
