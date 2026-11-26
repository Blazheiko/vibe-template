import { Result } from 'better-result'
import type { LlmSystemPromptId } from '#app/domain/ids.js'
import { uid } from '../../../test-support/ids.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

const adapter = { isConfigured: vi.fn(() => true), model: 'gpt-test', streamText: vi.fn() }
vi.mock('#app/services/ai/ai-provider.js', () => ({ textAdapter: adapter }))
const recorder = vi.fn()
const textUsageRecorder = vi.fn(() => recorder)
vi.mock('#app/services/ai/usage/llm-usage-service.js', () => ({
    llmUsageService: { textUsageRecorder },
}))
vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { promptTestService } = await import('./prompt-test-service.js')
const { appErrorMessage } = await import('#app/services/shared/errors.js')

const streamOf = (...chunks: string[]) =>
    async function* (): AsyncGenerator<string, string, undefined> {
        for (const chunk of chunks) yield chunk
        return chunks.join('')
    }
const failingWith = (error: unknown) =>
    // eslint-disable-next-line require-yield
    async function* (): AsyncGenerator<string, string, undefined> {
        throw error
    }

afterEach(() => {
    vi.clearAllMocks()
    adapter.isConfigured.mockReturnValue(true)
})

describe('promptTestService.run (code-issues item 23)', () => {
    it('returns the generated text and passes the request signal on', async () => {
        adapter.streamText.mockImplementation(streamOf('Hel', 'lo'))
        const controller = new AbortController()

        const result = await promptTestService.run('system', 'user', controller.signal)

        expect(result).toEqual(Result.ok('Hello'))
        expect(adapter.streamText.mock.calls[0]?.[0]).toMatchObject({
            systemPrompt: 'system',
            userPrompt: 'user',
            signal: controller.signal,
        })
    })

    it('is 503 when no provider is configured, without calling it', async () => {
        adapter.isConfigured.mockReturnValue(false)
        const result = await promptTestService.run('s', 'u')
        expect(Result.isError(result) && result.error._tag).toBe('ServiceUnavailable')
        expect(adapter.streamText).not.toHaveBeenCalled()
    })

    it('is UpstreamTimeout (504) when the provider runs out of time', async () => {
        adapter.streamText.mockImplementation(
            failingWith(new DOMException('timed out', 'TimeoutError')),
        )
        const result = await promptTestService.run('s', 'u')
        expect(Result.isError(result) && result.error._tag).toBe('UpstreamTimeout')
    })

    it('is UpstreamError (502) for a provider error, with its text kept out of the message', async () => {
        adapter.streamText.mockImplementation(
            failingWith(new Error('OpenAI error 500: secret internal detail')),
        )
        const result = await promptTestService.run('s', 'u')
        expect(Result.isError(result) && result.error._tag).toBe('UpstreamError')
        if (Result.isError(result)) {
            expect(appErrorMessage(result.error)).not.toContain('secret')
        }
    })

    it('records the call as PROMPT_TEST for the admin and the prompt (item 53)', async () => {
        adapter.streamText.mockImplementation(streamOf('ok'))

        await promptTestService.run('s', 'u', undefined, {
            userId: uid(1),
            llmSystemPromptId: 3n as LlmSystemPromptId,
        })

        expect(textUsageRecorder).toHaveBeenCalledWith('PROMPT_TEST', 1n, 3n)
        expect(adapter.streamText.mock.calls[0]?.[1]).toBe(recorder)
    })
})
