import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendHttp } from '@/utils/base-api'
import {
    executeRequest,
    executeThread,
    failedRunOf,
    singleResultOf,
    summaryOf,
    wsHandoffOf,
} from '../load-test'
import type { NumberedOutcome, Progress, RequestOutcome, RequestSpec } from '../load-test'

// feat-076 (J): what one request, one thread and a summary of many come to.

const spec: RequestSpec = {
    method: 'POST',
    url: 'http://h/api/x',
    headers: { 'Content-Type': 'application/json' },
    body: { a: 1 },
    hasBody: true,
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
})
afterEach(() => {
    vi.useRealTimers()
})

/** A client that takes 5 ms and answers with `reply`. */
function client(reply: Awaited<ReturnType<SendHttp>> | Error): SendHttp {
    return (() => {
        vi.advanceTimersByTime(5)
        return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)
    }) as SendHttp
}

describe('executeRequest', () => {
    it('is a success with the status, text and headers the client gave, and the time it took', async () => {
        const outcome = await executeRequest(
            client({
                data: { ok: 1 },
                error: null,
                status: 201,
                statusText: 'Created',
                headers: { x: 'y' },
            }),
            spec,
        )
        expect(outcome).toEqual({
            success: true,
            status: 201,
            statusText: 'Created',
            headers: { x: 'y' },
            data: { ok: 1 },
            responseTime: 5,
        })
    })

    it('says 200 OK when the client gave no status', async () => {
        const outcome = await executeRequest(client({ data: null, error: null }), spec)
        expect([outcome.status, outcome.statusText, outcome.headers]).toEqual([200, 'OK', {}])
    })

    it('sends the body only where the method carries one, and {} when it is null', async () => {
        const seen: unknown[] = []
        const send = ((method: string, url: string, body: unknown, headers: unknown) => {
            seen.push([method, url, body, headers])
            return Promise.resolve({ data: null, error: null })
        }) as SendHttp
        await executeRequest(send, spec)
        await executeRequest(send, { ...spec, hasBody: false })
        await executeRequest(send, { ...spec, body: null })
        expect(seen).toEqual([
            ['POST', 'http://h/api/x', { a: 1 }, spec.headers],
            ['POST', 'http://h/api/x', {}, spec.headers],
            ['POST', 'http://h/api/x', {}, spec.headers],
        ])
    })

    it('an error answer is a failure: its status, else the code; its text, else the message; an empty body becomes the message', async () => {
        const outcome = await executeRequest(
            client({ data: '', error: { message: 'Forbidden', code: 403 }, status: 0 }),
            spec,
        )
        expect(outcome).toMatchObject({
            success: false,
            error: true,
            status: 403,
            statusText: 'Forbidden',
            data: 'Forbidden',
        })

        const withBody = await executeRequest(
            client({
                data: { why: 'x' },
                error: { message: 'Bad', code: 400 },
                status: 422,
                statusText: 'Unprocessable',
            }),
            spec,
        )
        expect(withBody).toMatchObject({
            status: 422,
            statusText: 'Unprocessable',
            data: { why: 'x' },
        })
    })

    it('a throw is a Network Error with the message, and the time until it threw', async () => {
        const outcome = await executeRequest(client(new Error('socket hang up')), spec)
        expect(outcome).toEqual({
            success: false,
            status: 0,
            statusText: 'Network Error',
            headers: {},
            data: 'socket hang up',
            responseTime: 5,
            error: true,
        })
        const throwsText = (() => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- what a thrown string does
            throw 'plain text'
        }) as unknown as SendHttp
        const odd = await executeRequest(throwsText, spec)
        expect(odd.data).toBe('Unknown error')
    })
})

describe('executeThread', () => {
    it('numbers its requests and itself from 1, counts them as they finish and keeps their times', async () => {
        const progress: Progress = {
            totalRequests: 6,
            completedRequests: 0,
            currentThread: 0,
            totalThreads: 2,
            isVisible: true,
        }
        const thread = await executeThread(
            client({ data: null, error: null }),
            spec,
            1,
            3,
            progress,
        )
        expect(thread.threadId).toBe(2)
        expect(thread.results.map((r) => [r.requestNumber, r.threadId])).toEqual([
            [1, 2],
            [2, 2],
            [3, 2],
        ])
        expect(thread.responseTimes).toEqual([5, 5, 5])
        expect(thread.threadTotalTime).toBe(15)
        expect(progress.completedRequests).toBe(3)
        expect(progress.currentThread).toBe(2)
    })
})

const outcome = (over: Partial<NumberedOutcome> = {}): NumberedOutcome => ({
    success: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: null,
    responseTime: 10,
    requestNumber: 1,
    ...over,
})

describe('wsHandoffOf', () => {
    const reply = (data: unknown, success = true): RequestOutcome => outcome({ data, success })

    it('follows a wsUrl of a successful response, with its token or none', () => {
        expect(wsHandoffOf(reply({ wsUrl: 'ws://h', wsToken: 't' }))).toEqual({
            url: 'ws://h',
            token: 't',
        })
        expect(wsHandoffOf(reply({ wsUrl: 'ws://h' }))).toEqual({ url: 'ws://h', token: '' })
        expect(wsHandoffOf(reply({ wsUrl: 'ws://h', wsToken: 5 }))).toEqual({
            url: 'ws://h',
            token: '',
        })
    })

    it.each([
        ['a failed response', reply({ wsUrl: 'ws://h' }, false)],
        ['no data', reply(null)],
        ['text', reply('ws://h')],
        ['a wsUrl that is not text', reply({ wsUrl: 5 })],
        ['no wsUrl', reply({})],
    ])('ignores %s', (_name, value) => {
        expect(wsHandoffOf(value)).toBeNull()
    })
})

describe('singleResultOf and failedRunOf', () => {
    it('shows the one response with what was sent', () => {
        expect(singleResultOf(outcome({ data: { a: 1 }, responseTime: 7 }), spec)).toEqual({
            success: true,
            status: 200,
            statusText: 'OK',
            headers: {},
            data: { a: 1 },
            responseTime: 7,
            url: spec.url,
            method: 'POST',
            requestHeaders: spec.headers,
            requestBody: spec.body,
        })
    })

    it('shows a run that threw with its message', () => {
        expect(failedRunOf(new Error('boom'), spec)).toEqual({
            success: false,
            error: true,
            message: 'Network error or request failed',
            details: 'boom',
            url: spec.url,
            method: 'POST',
        })
        expect(failedRunOf('x', spec).details).toBe('Unknown error')
    })
})

describe('summaryOf', () => {
    const results = [
        outcome({ requestNumber: 1, responseTime: 10 }),
        outcome({ requestNumber: 2, responseTime: 30, success: false, error: true }),
        outcome({ requestNumber: 3, responseTime: 20 }),
    ]
    const responseTimes = [10, 30, 20]

    it('counts, averages over the wall-clock time and takes the extremes', () => {
        const summary = summaryOf({ spec, results, responseTimes, totalTime: 90, totalRequests: 3 })
        expect(summary.success).toBe(true)
        expect(summary.firstResult).toBe(results[0])
        expect(summary.statistics).toEqual({
            totalRequests: 3,
            successfulRequests: 2,
            failedRequests: 1,
            totalTime: 90,
            avgResponseTime: 30,
            minResponseTime: 10,
            maxResponseTime: 30,
        })
        expect(summary).toMatchObject({
            url: spec.url,
            method: 'POST',
            requestBody: spec.body,
            allResults: results,
        })
        expect(summary.threadResults).toBeUndefined()
    })

    it('is not a success when every request failed', () => {
        const failed = results.map((r) => ({ ...r, success: false }))
        expect(
            summaryOf({ spec, results: failed, responseTimes, totalTime: 1, totalRequests: 3 })
                .success,
        ).toBe(false)
    })

    it('adds the threads when there were some, and has 0 for the extremes of an empty run of them', () => {
        const threads = { threadCount: 2, requestsPerThread: 0, threadResults: [] }
        const summary = summaryOf({
            spec,
            results: [],
            responseTimes: [],
            totalTime: 5,
            totalRequests: 0,
            threads,
        })
        expect(summary.statistics).toMatchObject({
            threadCount: 2,
            requestsPerThread: 0,
            minResponseTime: 0,
            maxResponseTime: 0,
            avgResponseTime: 0,
        })
        expect(summary.threadResults).toEqual([])
        expect(summary.firstResult).toBeUndefined()
    })
})
