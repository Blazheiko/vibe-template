import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'

// feat-118 (R12b) on real PostgreSQL: every started provider call leaves exactly one
// llm_text_usage row, with how it ended (status) and where its tokens come from
// (tokens_estimated), through the audited adapter and the real usage recorder.

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import type { ITextAdapter, TextStreamOptions, TokenUsage } from '#app/services/ai/types.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!hasPg)('LLM usage audit (feat-118)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { llmTextUsage } = await import('#database/schema.js')
    const { llmUsageService } = await import('#app/services/ai/usage/llm-usage-service.js')
    const { withUsageAudit } = await import('#app/services/ai/usage/usage-audit.js')

    const run = `${String(Date.now())}-${String(process.pid)}`
    let counter = 0
    const models: string[] = []
    const newModel = (): string => {
        counter += 1
        const model = `audit-${run}-${String(counter)}`
        models.push(model)
        return model
    }

    afterAll(async () => {
        for (const model of models) {
            await db.delete(llmTextUsage).where(eq(llmTextUsage.model, model))
        }
        await pool.end()
    })

    // A provider: yields `tokens`, may report usage first, may fail at a step.
    const fakeAdapter = (script: {
        tokens: string[]
        usageBefore?: TokenUsage
        usageAtEnd?: TokenUsage
        failAt?: number
        error?: Error
    }): ITextAdapter =>
        withUsageAudit({
            isConfigured: () => true,
            model: 'unused',
            async *streamText(opts: TextStreamOptions, onComplete) {
                if (script.usageBefore !== undefined) opts.onUsageReported?.(script.usageBefore)
                let text = ''
                for (let i = 0; i < script.tokens.length; i += 1) {
                    if (script.failAt === i) throw script.error ?? new Error('provider failed')
                    await sleep(1)
                    const token = script.tokens[i] ?? ''
                    text += token
                    yield token
                }
                if (script.failAt === script.tokens.length) {
                    throw script.error ?? new Error('provider failed')
                }
                if (script.usageAtEnd !== undefined) {
                    onComplete?.(script.usageAtEnd, opts.modelOverride ?? 'unused', 'p')
                }
                return text
            },
        })

    const opts = (model: string): TextStreamOptions => ({
        systemPrompt: 'You are helpful.',
        userPrompt: 'How do I reset my password?',
        modelOverride: model,
    })

    // The recorder writes in the background: wait for the rows to land.
    const rowsOf = async (model: string, expected = 1) => {
        for (let i = 0; i < 100; i += 1) {
            const rows = await db.select().from(llmTextUsage).where(eq(llmTextUsage.model, model))
            if (rows.length >= expected) {
                await sleep(30)
                return db.select().from(llmTextUsage).where(eq(llmTextUsage.model, model))
            }
            await sleep(10)
        }
        return db.select().from(llmTextUsage).where(eq(llmTextUsage.model, model))
    }

    const consume = async (
        adapter: ITextAdapter,
        model: string,
        stopAfter = Number.POSITIVE_INFINITY,
    ): Promise<string> => {
        let text = ''
        let seen = 0
        for await (const token of adapter.streamText(
            opts(model),
            llmUsageService.textUsageRecorder('SUPPORT_CHAT', null),
        )) {
            text += token
            seen += 1
            if (seen >= stopAfter) break
        }
        return text
    }

    const REAL: TokenUsage = { promptTokens: 12, completionTokens: 5, totalTokens: 17 }

    it('success: one row, completed, with the reported tokens', async () => {
        const model = newModel()
        await consume(fakeAdapter({ tokens: ['Hel', 'lo'], usageAtEnd: REAL }), model)

        const rows = await rowsOf(model)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            status: 'completed',
            tokensEstimated: false,
            promptTokens: 12,
            completionTokens: 5,
            totalTokens: 17,
        })
    })

    it('a provider error before the first chunk: one row, failed, estimated tokens', async () => {
        const model = newModel()
        await expect(consume(fakeAdapter({ tokens: ['never'], failAt: 0 }), model)).rejects.toThrow(
            'provider failed',
        )

        const rows = await rowsOf(model)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ status: 'failed', tokensEstimated: true })
        // The prompt was sent: it is charged as an estimate, nothing was streamed.
        expect(rows[0]?.promptTokens).toBeGreaterThan(0)
        expect(rows[0]?.completionTokens).toBe(0)
    })

    it('usage reported, then the consumer stops: aborted with the real tokens', async () => {
        const model = newModel()
        await consume(fakeAdapter({ tokens: ['a', 'b', 'c'], usageBefore: REAL }), model, 1)

        const rows = await rowsOf(model)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            status: 'aborted',
            tokensEstimated: false,
            totalTokens: 17,
        })
    })

    it('stopped without usage: aborted with an estimate of the prompt and the text so far', async () => {
        const model = newModel()
        await consume(fakeAdapter({ tokens: ['abcd', 'efgh', 'ijkl'] }), model, 2)

        const rows = await rowsOf(model)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ status: 'aborted', tokensEstimated: true })
        // 8 characters streamed before the stop: 4 tokens by the characters / 2 estimate.
        expect(rows[0]?.completionTokens).toBe(4)
    })

    it('a cancel (AbortError) is aborted, a timeout is failed', async () => {
        const cancelled = newModel()
        const timedOut = newModel()
        const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' })
        const timeoutError = Object.assign(new Error('timeout'), { name: 'TimeoutError' })

        await expect(
            consume(fakeAdapter({ tokens: ['x'], failAt: 1, error: abortError }), cancelled),
        ).rejects.toThrow('cancelled')
        await expect(
            consume(fakeAdapter({ tokens: ['x'], failAt: 1, error: timeoutError }), timedOut),
        ).rejects.toThrow('timeout')

        expect((await rowsOf(cancelled))[0]?.status).toBe('aborted')
        expect((await rowsOf(timedOut))[0]?.status).toBe('failed')
    })

    // feat-121 (M2): a lost support lock cancels the call with its own reason, and fetch rejects
    // with that reason as it is: the caller's signal, not the error's name, makes it aborted.
    it('a lock lost mid-call (custom abort reason) is aborted, not failed', async () => {
        const model = newModel()
        const lock = new AbortController()
        const lockLost = Object.assign(new Error('The support lock was lost'), {
            name: 'SupportLockLostError',
        })
        const adapter = withUsageAudit({
            isConfigured: () => true,
            model: 'unused',
            async *streamText() {
                yield 'partial'
                lock.abort(lockLost)
                throw lockLost
            },
        })

        const run = async (): Promise<void> => {
            for await (const token of adapter.streamText(
                { ...opts(model), signal: lock.signal },
                llmUsageService.textUsageRecorder('SUPPORT_CHAT', null),
            ))
                expect(token).toBe('partial')
        }
        await expect(run()).rejects.toThrow('The support lock was lost')

        expect((await rowsOf(model))[0]?.status).toBe('aborted')
    })

    it('a completion and a late report on the same call: exactly one row', async () => {
        const model = newModel()
        const recorder = llmUsageService.textUsageRecorder('SUPPORT_CHAT', null)
        const adapter = fakeAdapter({ tokens: ['done'], usageAtEnd: REAL })
        const tokens: string[] = []
        for await (const token of adapter.streamText(opts(model), recorder)) tokens.push(token)
        expect(tokens).toEqual(['done'])

        // An error handler reporting the same call again after it completed.
        recorder(REAL, model, 'p', { status: 'failed', tokensEstimated: false })
        recorder(REAL, model, 'p', { status: 'aborted', tokensEstimated: true })

        const rows = await rowsOf(model)
        await sleep(50)
        expect(await rowsOf(model)).toHaveLength(1)
        expect(rows[0]?.status).toBe('completed')
    })

    it('a call that never started writes no row', async () => {
        const model = newModel()
        // The pipeline stopped before the paid step: the stream is created but never read.
        const adapter = fakeAdapter({ tokens: ['x'], usageAtEnd: REAL })
        void adapter.streamText(
            opts(model),
            llmUsageService.textUsageRecorder('SUPPORT_CHAT', null),
        )

        await sleep(100)
        expect(await db.select().from(llmTextUsage).where(eq(llmTextUsage.model, model))).toEqual(
            [],
        )
    })

    it('statistics keep reported and estimated tokens apart, and count how calls ended', async () => {
        const model = newModel()
        await consume(fakeAdapter({ tokens: ['ok'], usageAtEnd: REAL }), model)
        await consume(fakeAdapter({ tokens: ['abcd', 'efgh'] }), model, 1)
        await expect(consume(fakeAdapter({ tokens: ['x'], failAt: 0 }), model)).rejects.toThrow()
        await rowsOf(model, 3)

        const { text } = await llmUsageService.getStats()
        const stat = text.find((row) => row.model === model)

        expect(stat).toMatchObject({
            totalCalls: 3,
            totalTokens: 17,
            callsWithoutUsage: 2,
            abortedCalls: 1,
            failedCalls: 1,
        })
        expect(stat?.estimatedTokens).toBeGreaterThan(0)
    })
})
