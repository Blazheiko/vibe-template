import { afterEach, describe, expect, it, vi } from 'vitest'

// The estimate a support answer reserves (ADR 0003): per call, in tokens, from the message
// and the configured limits of the output.

const getMaxTokens = vi.fn<(type: string) => number | null>()
vi.mock('#app/services/ai/prompt-service.js', () => ({
    promptService: { getMaxTokens },
}))
vi.mock('#config/ai.js', () => ({
    default: { supportPromptAllowanceTokens: 8_000, supportDailyTokenBudget: 200_000 },
}))

const { estimateSupportParts, tokensOfText } = await import('./support-budget.js')

afterEach(() => {
    vi.clearAllMocks()
})

describe('tokensOfText', () => {
    it('is half the characters, rounded up: a heuristic, not a bound', () => {
        expect(tokensOfText('')).toBe(0)
        expect(tokensOfText('a')).toBe(1)
        expect(tokensOfText('abcd')).toBe(2)
        expect(tokensOfText('abcde')).toBe(3)
    })
})

describe('estimateSupportParts', () => {
    it('splits a message into translation, embedding and answer with the default output limits', () => {
        getMaxTokens.mockReturnValue(null)
        const message = 'a'.repeat(1000) // 500 tokens

        expect(estimateSupportParts(message)).toEqual({
            translation: 500 + 500, // the message + SUPPORT_QUERY_TRANSLATION maxTokens (500)
            embedding: 500,
            chat: 8_000 + 500 + 2_048, // allowance + the message + SUPPORT_SYSTEM maxTokens
        })
    })

    it('takes the output limits an admin set on the prompts', () => {
        getMaxTokens.mockImplementation((type) =>
            type === 'SUPPORT_SYSTEM' ? 4_096 : type === 'SUPPORT_QUERY_TRANSLATION' ? 100 : null,
        )

        expect(estimateSupportParts('abcd')).toEqual({
            translation: 2 + 100,
            embedding: 2,
            chat: 8_000 + 2 + 4_096,
        })
    })

    it('estimates the greeting as one answer without a message', () => {
        getMaxTokens.mockReturnValue(null)

        expect(estimateSupportParts(null)).toEqual({ chat: 8_000 + 512 })
    })

    it('grows with the length of the message', () => {
        getMaxTokens.mockReturnValue(null)
        const short = estimateSupportParts('a'.repeat(100))
        const long = estimateSupportParts('a'.repeat(4000))

        expect(sumOf(long)).toBeGreaterThan(sumOf(short))
    })
})

const sumOf = (parts: Record<string, number>): number =>
    Object.values(parts).reduce((a, b) => a + b, 0)
