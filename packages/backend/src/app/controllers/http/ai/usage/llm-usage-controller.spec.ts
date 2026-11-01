import { describe, expect, it, vi } from 'vitest'

import { type } from '@arktype/type'
import { GetTextUsageResponseSchema } from 'shared'
import type { HttpContext } from '#vendor/types/types.js'

const getTextUsage = vi.fn()
vi.mock('#app/services/ai/usage/llm-usage-service.js', () => ({
    llmUsageService: { getTextUsage, getStats: vi.fn() },
}))

const { default: LlmUsageController } = await import('./llm-usage-controller.js')

describe('LlmUsageController.getTextUsage (item 53)', () => {
    it('serializes NULL user and token counts as null and matches the response schema', async () => {
        getTextUsage.mockResolvedValue({
            rows: [
                {
                    id: 1n,
                    userId: null,
                    model: 'emb',
                    feature: 'SUPPORT_EMBEDDING',
                    finalPrompt: 'text',
                    promptSha256: 'a'.repeat(64),
                    promptChars: 4,
                    promptTokens: null,
                    completionTokens: null,
                    totalTokens: null,
                    createdAt: new Date(0),
                },
            ],
            total: 1,
        })

        const response = await LlmUsageController.getTextUsage({
            httpData: { query: { page: 1, limit: 10 } },
        } as unknown as HttpContext<unknown, never>)

        expect('data' in response && response.data.rows[0]).toMatchObject({
            userId: null,
            promptTokens: null,
            totalTokens: null,
        })
        expect(GetTextUsageResponseSchema(response) instanceof type.errors).toBe(false)
    })

    // feat-065: a row written while the prompt text is not kept has an empty text. It is answered
    // as "no text" (null), not as an empty prompt, and its hash and length are still there.
    it('answers no text for a row that kept none, with the hash and the length', async () => {
        getTextUsage.mockResolvedValue({
            rows: [
                {
                    id: 2n,
                    userId: 7n,
                    model: 'gpt',
                    feature: 'SUPPORT_CHAT',
                    finalPrompt: '',
                    promptSha256: 'b'.repeat(64),
                    promptChars: 321,
                    promptTokens: 10,
                    completionTokens: 20,
                    totalTokens: 30,
                    createdAt: new Date(0),
                },
            ],
            total: 1,
        })

        const response = await LlmUsageController.getTextUsage({
            httpData: { query: { page: 1, limit: 10 } },
        } as unknown as HttpContext<unknown, never>)

        expect('data' in response && response.data.rows[0]).toMatchObject({
            finalPrompt: null,
            promptSha256: 'b'.repeat(64),
            promptChars: 321,
        })
        expect(GetTextUsageResponseSchema(response) instanceof type.errors).toBe(false)
    })

    it('answers the text of a row that kept it', async () => {
        getTextUsage.mockResolvedValue({
            rows: [
                {
                    id: 3n,
                    userId: 7n,
                    model: 'gpt',
                    feature: 'PROMPT_TEST',
                    finalPrompt: 'the prompt',
                    promptSha256: 'c'.repeat(64),
                    promptChars: 10,
                    promptTokens: 1,
                    completionTokens: 2,
                    totalTokens: 3,
                    createdAt: new Date(0),
                },
            ],
            total: 1,
        })

        const response = await LlmUsageController.getTextUsage({
            httpData: { query: { page: 1, limit: 10 } },
        } as unknown as HttpContext<unknown, never>)

        expect('data' in response && response.data.rows[0]?.finalPrompt).toBe('the prompt')
    })

    it('accepts a row from before the hash existed (no hash, no length)', async () => {
        getTextUsage.mockResolvedValue({
            rows: [
                {
                    id: 4n,
                    userId: null,
                    model: 'gpt',
                    feature: 'SUPPORT_EMBEDDING',
                    finalPrompt: 'old text',
                    promptSha256: null,
                    promptChars: null,
                    promptTokens: null,
                    completionTokens: null,
                    totalTokens: null,
                    createdAt: new Date(0),
                },
            ],
            total: 1,
        })

        const response = await LlmUsageController.getTextUsage({
            httpData: { query: { page: 1, limit: 10 } },
        } as unknown as HttpContext<unknown, never>)

        expect(GetTextUsageResponseSchema(response) instanceof type.errors).toBe(false)
        expect('data' in response && response.data.rows[0]).toMatchObject({
            promptSha256: null,
            promptChars: null,
        })
    })
})
