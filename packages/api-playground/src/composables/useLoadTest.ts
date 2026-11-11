import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import baseApi from '@/utils/base-api'
import type { SendHttp } from '@/utils/base-api'
import {
    clampCount,
    executeRequest,
    executeThread,
    failedRunOf,
    MAX_REQUESTS_PER_THREAD,
    MAX_THREADS,
    singleResultOf,
    summaryOf,
} from '@/utils/load-test'
import type {
    NumberedOutcome,
    Progress,
    RequestOutcome,
    RequestSpec,
    TestResult,
} from '@/utils/load-test'

export interface LoadTestOptions {
    /** Requests each thread sends one after another. */
    requestCount: Ref<number>
    /** Threads that send at the same time. */
    threadCount: Ref<number>
    /** Replaces the client, for a test. */
    send?: SendHttp
    /** Told of the response when the run was one request, e.g. to follow a `wsUrl` in it. */
    onSingleResponse?: (outcome: RequestOutcome) => void
}

export interface LoadTest {
    testResult: Ref<TestResult | null>
    isLoading: Ref<boolean>
    progress: Ref<Progress>
    progressPercentage: ComputedRef<number>
    run: (spec: RequestSpec) => Promise<void>
    /** Ends the run after the requests already on their way; the summary is of what was sent. */
    stop: () => void
    clear: () => void
}

/** How long the progress bar stays up after the run ends. */
const PROGRESS_LINGER_MS = 1000

/**
 * Sends a request once, or many times on one or several threads, and keeps what the response pane
 * shows: the result, whether a run is in progress, and how far it has got.
 */
export function useLoadTest(options: LoadTestOptions): LoadTest {
    const send: SendHttp = options.send ?? ((...args) => baseApi.http(...args))
    const testResult = ref<TestResult | null>(null)
    const isLoading = ref(false)
    const progress = ref<Progress>({
        totalRequests: 0,
        completedRequests: 0,
        currentThread: 0,
        totalThreads: 0,
        isVisible: false,
    })

    const progressPercentage = computed(() => {
        if (progress.value.totalRequests === 0) return 0
        return Math.round((progress.value.completedRequests / progress.value.totalRequests) * 100)
    })

    let stopRequested = false
    const shouldStop = (): boolean => stopRequested

    async function runOnOneThread(spec: RequestSpec, requestCount: number): Promise<void> {
        const startedAt = Date.now()
        const results: NumberedOutcome[] = []
        const responseTimes: number[] = []

        for (let i = 0; i < requestCount && !stopRequested; i++) {
            progress.value.currentThread = 1
            const result = await executeRequest(send, spec)
            results.push({ ...result, requestNumber: i + 1 })
            responseTimes.push(result.responseTime)
            progress.value.completedRequests++
        }

        const first = results[0] as NumberedOutcome | undefined
        if (requestCount === 1) {
            if (first) {
                testResult.value = singleResultOf(first, spec)
                options.onSingleResponse?.(first)
            }
            return
        }

        testResult.value = summaryOf({
            spec,
            results,
            responseTimes,
            totalTime: Date.now() - startedAt,
            totalRequests: requestCount,
        })
    }

    async function runOnThreads(
        spec: RequestSpec,
        requestCount: number,
        threadCount: number,
    ): Promise<void> {
        const startedAt = Date.now()

        const threads = await Promise.all(
            Array.from({ length: threadCount }, (_, index) =>
                executeThread(send, spec, index, requestCount, progress.value, shouldStop),
            ),
        )

        testResult.value = summaryOf({
            spec,
            results: threads.flatMap((thread) => thread.results),
            responseTimes: threads.flatMap((thread) => thread.responseTimes),
            totalTime: Date.now() - startedAt,
            totalRequests: threadCount * requestCount,
            threads: { threadCount, requestsPerThread: requestCount, threadResults: threads },
        })
    }

    async function run(spec: RequestSpec): Promise<void> {
        // The bounds are here, not only in the form's `min` / `max`: a typed 100000 or an
        // emptied field would otherwise be the size of the run.
        const requestCount = clampCount(options.requestCount.value, MAX_REQUESTS_PER_THREAD)
        const threadCount = clampCount(options.threadCount.value, MAX_THREADS)
        stopRequested = false
        isLoading.value = true
        testResult.value = null
        progress.value = {
            totalRequests: threadCount * requestCount,
            completedRequests: 0,
            currentThread: 0,
            totalThreads: threadCount,
            isVisible: true,
        }

        try {
            if (threadCount === 1) await runOnOneThread(spec, requestCount)
            else await runOnThreads(spec, requestCount, threadCount)
        } catch (error) {
            console.error(error)
            testResult.value = failedRunOf(error, spec)
        } finally {
            isLoading.value = false
            window.setTimeout(() => {
                progress.value.isVisible = false
            }, PROGRESS_LINGER_MS)
        }
    }

    function stop(): void {
        stopRequested = true
    }

    function clear(): void {
        testResult.value = null
        progress.value.isVisible = false
    }

    return { testResult, isLoading, progress, progressPercentage, run, stop, clear }
}
