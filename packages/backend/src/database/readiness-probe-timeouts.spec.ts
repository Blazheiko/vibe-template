import { describe, expect, it, vi } from 'vitest'

vi.mock('#logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

// feat-138 (sixth review L14): the probe gave the connection and the query timeoutMs each, so the
// worst probe took about twice READINESS_CHECK_TIMEOUT_MS, and /ready (refusing a second probe
// while one is in flight) recovered that much later. Together they now stay within timeoutMs.
describe('readiness probe timeouts', () => {
    it.each([2_000, 1_000, 3, 1])(
        'split %d ms between the connection and the query',
        async (timeoutMs) => {
            const { probeTimeouts } = await import('./readiness-probe.js')
            const { connectMs, queryMs } = probeTimeouts(timeoutMs)

            expect(connectMs).toBeGreaterThan(0)
            expect(queryMs).toBeGreaterThan(0)
            expect(connectMs + queryMs).toBeLessThanOrEqual(Math.max(timeoutMs, 2))
        },
    )
})
