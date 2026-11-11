import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { SendHttp } from '@/utils/base-api'
import type { RequestSpec } from '@/utils/load-test'
import { useLoadTest } from '../useLoadTest'
import type { LoadTest } from '../useLoadTest'

// feat-076 (J): the run of a request, once or many times, on one thread or several.

const spec: RequestSpec = {
    method: 'GET',
    url: 'http://h/api/x',
    headers: { a: 'b' },
    body: undefined,
    hasBody: false,
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout.bind(globalThis) })
})
afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

/** Each call takes 10 ms; the answers are used in turn, 'throw' rejects. */
function scripted(answers: ('ok' | 'fail' | 'throw')[]): SendHttp {
    const queue = [...answers]
    return (() => {
        vi.advanceTimersByTime(10)
        const next = queue.shift() ?? 'ok'
        if (next === 'throw') return Promise.reject(new Error('down'))
        if (next === 'fail') {
            return Promise.resolve({
                data: 'no',
                error: { message: 'bad', code: 500 },
                status: 500,
            })
        }
        return Promise.resolve({ data: { fine: true }, error: null, status: 200 })
    }) as SendHttp
}

function setup(
    requests: number,
    threads: number,
    send: SendHttp,
    onSingleResponse: (outcome: unknown) => void = vi.fn(),
) {
    const test = useLoadTest({
        requestCount: ref(requests),
        threadCount: ref(threads),
        send,
        onSingleResponse,
    })
    return { test, onSingleResponse }
}

describe('useLoadTest', () => {
    it('one request: the response itself, and the caller is told of it', async () => {
        const { test, onSingleResponse } = setup(1, 1, scripted(['ok']))
        await test.run(spec)
        expect(test.testResult.value).toMatchObject({
            success: true,
            status: 200,
            data: { fine: true },
            responseTime: 10,
            url: spec.url,
            method: 'GET',
        })
        expect(test.testResult.value?.statistics).toBeUndefined()
        expect(onSingleResponse).toHaveBeenCalledTimes(1)
    })

    it('many on one thread: a summary averaged over the wall-clock time, with no thread fields', async () => {
        const { test, onSingleResponse } = setup(4, 1, scripted(['ok', 'ok', 'fail', 'ok']))
        await test.run(spec)
        expect(test.testResult.value?.statistics).toEqual({
            totalRequests: 4,
            successfulRequests: 3,
            failedRequests: 1,
            totalTime: 40,
            avgResponseTime: 10,
            minResponseTime: 10,
            maxResponseTime: 10,
        })
        expect(test.testResult.value?.allResults?.map((r) => r.requestNumber)).toEqual([1, 2, 3, 4])
        expect(test.testResult.value?.threadResults).toBeUndefined()
        expect(onSingleResponse).not.toHaveBeenCalled()
    })

    it('several threads: all their results, per thread, with the thread fields', async () => {
        const { test, onSingleResponse } = setup(
            2,
            3,
            scripted(['ok', 'ok', 'throw', 'ok', 'ok', 'ok']),
        )
        await test.run(spec)
        const result = test.testResult.value
        expect(result?.statistics).toMatchObject({
            totalRequests: 6,
            successfulRequests: 5,
            failedRequests: 1,
            threadCount: 3,
            requestsPerThread: 2,
        })
        expect(result?.threadResults).toHaveLength(3)
        expect(result?.allResults).toHaveLength(6)
        expect(onSingleResponse).not.toHaveBeenCalled()
    })

    it('one request on several threads is still a summary, not a single response', async () => {
        const { test } = setup(1, 2, scripted(['ok', 'ok']))
        await test.run(spec)
        expect(test.testResult.value?.statistics?.totalRequests).toBe(2)
    })

    it('is loading during the run only, and the bar lingers for a second after it', async () => {
        const { test } = setup(1, 1, scripted(['ok']))
        expect(test.isLoading.value).toBe(false)
        const done = test.run(spec)
        expect(test.isLoading.value).toBe(true)
        expect(test.progress.value).toMatchObject({ totalRequests: 1, isVisible: true })
        await done
        expect(test.isLoading.value).toBe(false)
        expect(test.progress.value.isVisible).toBe(true)
        expect(test.progressPercentage.value).toBe(100)
        await vi.advanceTimersByTimeAsync(1000)
        expect(test.progress.value.isVisible).toBe(false)
    })

    it('counts the percentage as requests finish', async () => {
        const seen: number[] = []
        const test: LoadTest = useLoadTest({
            requestCount: ref(4),
            threadCount: ref(1),
            send: () => {
                seen.push(test.progressPercentage.value)
                return Promise.resolve({ data: null, error: null })
            },
        })
        await test.run(spec)
        expect(seen).toEqual([0, 25, 50, 75])
        expect(test.progressPercentage.value).toBe(100)
    })

    it('the previous result is gone as the next run starts', async () => {
        const { test } = setup(1, 1, scripted(['ok', 'ok']))
        await test.run(spec)
        const second = test.run(spec)
        expect(test.testResult.value).toBeNull()
        await second
        expect(test.testResult.value).not.toBeNull()
    })

    it('something unexpected becomes a failed run, is logged, and still ends the loading', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const { test } = setup(1, 1, scripted(['ok']), () => {
            throw new Error('handler broke')
        })
        await test.run(spec)
        expect(test.testResult.value).toMatchObject({
            success: false,
            error: true,
            message: 'Network error or request failed',
            details: 'handler broke',
        })
        expect(test.isLoading.value).toBe(false)
        expect(log).toHaveBeenCalled()
    })

    it('clear drops the result and the bar', async () => {
        const { test } = setup(1, 1, scripted(['ok']))
        await test.run(spec)
        test.clear()
        expect(test.testResult.value).toBeNull()
        expect(test.progress.value.isVisible).toBe(false)
    })
})

// feat-165 (review 2026-11-10): the bounds of a run were the `min` / `max` of two number inputs,
// which a typed value ignores, and a run could not be stopped.
describe('useLoadTest: the size of a run', () => {
    it('zero requests is a run of one, not a summary with Infinity', async () => {
        const send = vi.fn(scripted([]))
        const { test } = setup(0, 1, send)

        await test.run(spec)

        expect(send).toHaveBeenCalledTimes(1)
        expect(test.testResult.value).toMatchObject({ success: true, status: 200 })
        expect(test.testResult.value?.statistics).toBeUndefined()
    })

    it('an emptied field is a run of one', async () => {
        const send = vi.fn(scripted([]))
        const { test } = setup('' as unknown as number, 1, send)

        await test.run(spec)

        expect(send).toHaveBeenCalledTimes(1)
    })

    it('100000 threads are 100', async () => {
        const send = vi.fn(scripted([]))
        const { test } = setup(1, 100_000, send)

        await test.run(spec)

        expect(send).toHaveBeenCalledTimes(100)
        expect(test.testResult.value?.statistics).toMatchObject({
            totalRequests: 100,
            threadCount: 100,
        })
    })

    it('100000 requests are 1000', async () => {
        const send = vi.fn(scripted([]))
        const { test } = setup(100_000, 1, send)

        await test.run(spec)

        expect(send).toHaveBeenCalledTimes(1000)
    })
})

describe('useLoadTest: stop', () => {
    it('ends a run on one thread after the request on its way; the summary is of what was sent', async () => {
        const holder: { test?: LoadTest } = {}
        let sent = 0
        const send = (() => {
            sent++
            if (sent === 3) holder.test?.stop()
            vi.advanceTimersByTime(10)
            return Promise.resolve({ data: {}, error: null, status: 200 })
        }) as SendHttp
        const { test } = setup(50, 1, send)
        holder.test = test

        await test.run(spec)

        expect(sent).toBe(3)
        expect(test.isLoading.value).toBe(false)
        expect(test.testResult.value?.allResults).toHaveLength(3)
        expect(test.testResult.value?.statistics).toMatchObject({
            successfulRequests: 3,
            avgResponseTime: 10,
        })
    })

    it('ends every thread', async () => {
        const holder: { test?: LoadTest } = {}
        let sent = 0
        const send = (() => {
            sent++
            if (sent === 8) holder.test?.stop()
            return Promise.resolve({ data: {}, error: null, status: 200 })
        }) as SendHttp
        const { test } = setup(100, 4, send)
        holder.test = test

        await test.run(spec)

        // The four requests of the round in which stop was asked are sent; nothing after it.
        expect(sent).toBe(8)
        expect(test.testResult.value?.allResults).toHaveLength(8)
    })

    it('a stop of one run does not end the next', async () => {
        const send = vi.fn(scripted([]))
        const { test } = setup(3, 1, send)
        test.stop()

        await test.run(spec)

        expect(send).toHaveBeenCalledTimes(3)
    })
})
