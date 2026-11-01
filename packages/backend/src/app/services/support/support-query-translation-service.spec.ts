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
