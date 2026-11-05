import { describe, expect, it, vi } from 'vitest'

// feat-126: auditCall reports a call once, whatever ends it first. The recorder has its own flag;
// this checks the audit's, which the review found no test would miss.
vi.mock('#logger', () => ({ default: { warn: vi.fn(), debug: vi.fn() } }))

const { auditCall } = await import('./usage-audit.js')

describe('auditCall (feat-126)', () => {
    it('settles once: a later failure or abort reports nothing', () => {
        const onComplete = vi.fn()
        const audit = auditCall(onComplete, 'model', 'prompt')
        audit.keep({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })

        audit.settle('completed', 10)
        audit.settle('failed', 10)
        audit.settle('aborted', 10)

        expect(onComplete).toHaveBeenCalledTimes(1)
        expect(onComplete).toHaveBeenCalledWith(
            { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
            'model',
            'prompt',
            { status: 'completed', tokensEstimated: false },
        )
    })

    it('a handler that throws is reported once and does not break the caller', () => {
        const onComplete = vi.fn(() => {
            throw new Error('recorder failed')
        })
        const audit = auditCall(onComplete, 'model', 'prompt')

        expect(() => {
            audit.settle('failed', 0)
            audit.settle('failed', 0)
        }).not.toThrow()
        expect(onComplete).toHaveBeenCalledTimes(1)
    })
})
