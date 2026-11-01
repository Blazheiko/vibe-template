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
