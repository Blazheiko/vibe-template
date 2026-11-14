import { afterEach, describe, expect, it, vi } from 'vitest'

const adapter = { isConfigured: vi.fn(() => true), streamText: vi.fn() }
vi.mock('#app/services/ai/ai-provider.js', () => ({ getTextAdapterForModel: () => adapter }))
vi.mock('#app/services/ai/prompt-service.js', () => ({
    promptService: {
        getModel: vi.fn(() => null),
        getTemperature: vi.fn(() => null),
        getMaxTokens: vi.fn(() => null),
        getContent: vi.fn(() => ''),
        get: vi.fn(() => ({ id: 4n })),
    },
}))
const recorder = vi.fn()
const textUsageRecorder = vi.fn(() => recorder)
vi.mock('#app/services/ai/usage/llm-usage-service.js', () => ({
    llmUsageService: { textUsageRecorder },
}))
vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { supportQueryTranslationService } = await import('./support-query-translation-service.js')

afterEach(() => {
    vi.clearAllMocks()
})

describe('supportQueryTranslationService.translateToEnglish', () => {
    it('records the translation as SUPPORT_QUERY_TRANSLATION for the user (item 53)', async () => {
        adapter.streamText.mockImplementation(async function* () {
            yield 'Hello'
            return 'Hello'
        })
        const controller = new AbortController()

        const result = await supportQueryTranslationService.translateToEnglish('Привіт', {
            userId: 7n,
            signal: controller.signal,
        })

        expect(result).toBe('Hello')
        expect(textUsageRecorder).toHaveBeenCalledWith(
            'SUPPORT_QUERY_TRANSLATION',
            7n,
            4n,
            undefined,
        )
        expect(adapter.streamText.mock.calls[0]?.[1]).toBe(recorder)
        expect(adapter.streamText.mock.calls[0]?.[0]).toMatchObject({ signal: controller.signal })
    })
})

// feat-150 (review 2026-11-10, M3): the user's message is what they wrote to support. A failed
// translation falls back to it, and the log says only how long it was.
describe('supportQueryTranslationService.translateToEnglish: what a failure logs', () => {
    const QUERY = 'Мій пароль не приймається, пошта olena@example.test'

    it('logs the failure without the text of the message', async () => {
        const { default: logger } = await import('#logger')
        // eslint-disable-next-line require-yield
        adapter.streamText.mockImplementation(async function* () {
            await Promise.resolve()
            throw new Error('provider answered 500')
        })

        const result = await supportQueryTranslationService.translateToEnglish(QUERY, {})

        expect(result).toBe(QUERY)
        expect(logger.error).toHaveBeenCalledTimes(1)
        const logged = JSON.stringify(vi.mocked(logger.error).mock.calls)
        expect(logged).not.toContain(QUERY)
        expect(logged).not.toContain('olena@example.test')
        expect(vi.mocked(logger.error).mock.calls[0]?.[0]).toMatchObject({
            originalLength: QUERY.length,
        })
    })

    it('does not log an error when the client went away during the translation', async () => {
        const { default: logger } = await import('#logger')
        // eslint-disable-next-line require-yield
        adapter.streamText.mockImplementation(async function* () {
            await Promise.resolve()
            throw new DOMException('The operation was aborted', 'AbortError')
        })

        const result = await supportQueryTranslationService.translateToEnglish(QUERY, {})

        expect(result).toBe(QUERY)
        expect(logger.error).not.toHaveBeenCalled()
        expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(QUERY)
    })
})
