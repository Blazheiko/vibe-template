import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HttpContext } from '#vendor/types/types.js'

const run = vi.fn()
vi.mock('#app/services/ai/prompt-test-service.js', () => ({ promptTestService: { run } }))
vi.mock('#app/services/ai/prompt-service.js', () => ({
    promptService: {
        get: vi.fn(() => ({ id: 3n, type: 'SUPPORT_SYSTEM', content: 'system prompt' })),
    },
}))

const { default: PromptController } = await import('./prompt-controller.js')
const { upstreamError, upstreamTimeout } = await import('#app/services/shared/errors.js')

const context = (signal: AbortSignal) =>
    ({
        httpData: { params: { type: 'SUPPORT_SYSTEM' }, payload: { message: 'hi' } },
        auth: { getUserId: () => '1' },
        responseData: { status: 200, payload: null, headers: [], cookies: new Map() },
        signal,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }) as unknown as HttpContext<{ message: string }, null, { type: string }>

afterEach(() => {
    vi.clearAllMocks()
})

describe('PromptController.testPrompt', () => {
    it('passes the request signal to the service and returns the text', async () => {
        run.mockResolvedValue(Result.ok('answer'))
        const controller = new AbortController()

        const response = await PromptController.testPrompt(context(controller.signal))

        expect(run).toHaveBeenCalledWith('system prompt', 'hi', controller.signal, {
            userId: 1n,
            llmSystemPromptId: 3n,
        })
        expect(response).toEqual({ status: 'success', result: 'answer' })
    })

    it.each([
        ['upstream timeout', upstreamTimeout(new Error('x')), 504, 'upstream_timeout'],
        ['upstream error', upstreamError(new Error('x')), 502, 'upstream_error'],
    ])('maps %s to HTTP %i', async (_name, error, status, code) => {
        run.mockResolvedValue(Result.err(error))
        const ctx = context(new AbortController().signal)

        const response = await PromptController.testPrompt(ctx)

        expect(ctx.responseData.status).toBe(status)
        expect(response).toMatchObject({ status: 'error', code })
    })
})
