import { afterEach, describe, expect, it, vi } from 'vitest'

const adapter = { isConfigured: vi.fn(() => true), streamText: vi.fn() }
vi.mock('#app/services/ai/ai-provider.js', () => ({ getTextAdapterForModel: () => adapter }))
const getContent = vi.fn((): string => '')
vi.mock('#app/services/ai/prompt-service.js', () => ({
    promptService: {
        getModel: vi.fn(() => null),
        getTemperature: vi.fn(() => null),
        getMaxTokens: vi.fn(() => null),
        getContent,
        get: vi.fn(() => ({ id: 4n })),
    },
}))
const warn = vi.fn()
vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() },
}))

const { supportLlmService } = await import('./support-llm-service.js')

afterEach(() => {
    vi.clearAllMocks()
})

async function systemPromptFor(template: string, context: string): Promise<string> {
    getContent.mockReturnValue(template)
    adapter.streamText.mockImplementation(async function* () {
        yield 'ok'
    })
    for await (const _chunk of supportLlmService.chatStream('question', context, [], 'en')) {
        // drain
    }
    const request = adapter.streamText.mock.calls[0]?.[0] as { systemPrompt: string }
    return request.systemPrompt
}

describe('supportLlmService.chatStream system prompt (feat-105)', () => {
    it.each(['Price: $& total', "Before $' after", 'Tick $` tock', 'Cost $$5', 'All $1 $<name>'])(
        'puts knowledge-base text with %s in verbatim',
        async (context) => {
            const prompt = await systemPromptFor('RULES\n{context}\nEND', context)

            expect(prompt.startsWith(`RULES\n${context}\nEND`)).toBe(true)
            expect(warn).not.toHaveBeenCalled()
        },
    )

    it('appends the context when the template has no placeholder', async () => {
        const prompt = await systemPromptFor('RULES ONLY', 'Price: $&')

        expect(prompt.startsWith('RULES ONLY\n\nKNOWLEDGE BASE CONTEXT:\nPrice: $&')).toBe(true)
        expect(warn).toHaveBeenCalledTimes(1)
    })

    it('does not mistake a context equal to the placeholder for a missing placeholder', async () => {
        const prompt = await systemPromptFor('RULES\n{context}', '{context}')

        expect(prompt.startsWith('RULES\n{context}')).toBe(true)
        expect(warn).not.toHaveBeenCalled()
    })
})
