import type { SendHttp } from '@/utils/base-api'

/** What one request came to, whether or not it succeeded. */
export interface RequestOutcome {
    success: boolean
    status: number
    statusText: string
    headers: Record<string, string>
    data: unknown
    responseTime: number
    error?: boolean
}

export interface NumberedOutcome extends RequestOutcome {
    requestNumber: number
    threadId?: number
}

export interface ThreadResult {
    threadId: number
    results: NumberedOutcome[]
    responseTimes: number[]
    threadTotalTime: number
}

export interface LoadStatistics {
    totalRequests: number
    successfulRequests: number
    failedRequests: number
    totalTime: number
    avgResponseTime: number
    minResponseTime: number
    maxResponseTime: number
    /** Only in a run on more than one thread. */
    threadCount?: number
    requestsPerThread?: number
}

/**
 * What the response pane shows. One shape for the four things it can be, so the template reads
 * the fields it needs without caring which:
 * - one response: `status`, `statusText`, `headers`, `data`, `responseTime`
 * - a run of many: `firstResult`, `statistics`, `allResults` (and `threadResults` on threads)
 * - a run that threw: `error`, `message`, `details`
 */
export interface TestResult {
    success: boolean
    error?: boolean
    status?: number
    statusText?: string
    headers?: Record<string, string>
    data?: unknown
    responseTime?: number
    url: string
    method: string
    requestHeaders?: Record<string, string>
    requestBody?: unknown
    message?: string
    details?: string
    firstResult?: NumberedOutcome
    statistics?: LoadStatistics
    allResults?: NumberedOutcome[]
    threadResults?: ThreadResult[]
}

export interface RequestSpec {
    method: string
    url: string
    headers: Record<string, string>
    /** Sent only where the method carries a body. */
    body: unknown
    hasBody: boolean
}

/** One request: never throws, a failure is an outcome with `success: false`. */
export async function executeRequest(send: SendHttp, spec: RequestSpec): Promise<RequestOutcome> {
    const startTime = Date.now()

    try {
        const payload =
            spec.body !== null && spec.hasBody ? (spec.body as Record<string, unknown>) : {}

        const apiResponse = await send(spec.method, spec.url, payload, spec.headers)
        const responseTime = Date.now() - startTime

        if (apiResponse.error) {
            return {
                success: false,
                status: apiResponse.status || apiResponse.error.code,
                statusText: apiResponse.statusText || apiResponse.error.message,
                headers: apiResponse.headers ?? {},
                // `||`: an empty or falsy body falls back to the error message
                // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
                data: apiResponse.data || apiResponse.error.message,
                responseTime,
                error: true,
            }
        }

        return {
            success: true,
            status: apiResponse.status || 200,
            statusText: apiResponse.statusText || 'OK',
            headers: apiResponse.headers ?? {},
            data: apiResponse.data,
            responseTime,
        }
    } catch (requestError) {
        return {
            success: false,
            status: 0,
            statusText: 'Network Error',
            headers: {},
            data: requestError instanceof Error ? requestError.message : 'Unknown error',
            responseTime: Date.now() - startTime,
            error: true,
        }
    }
}

export interface Progress {
    totalRequests: number
    completedRequests: number
    currentThread: number
    totalThreads: number
    isVisible: boolean
}

/** One thread: `requestCount` requests one after another. */
export async function executeThread(
    send: SendHttp,
    spec: RequestSpec,
    threadIndex: number,
    requestCount: number,
    progress: Progress,
): Promise<ThreadResult> {
    const results: NumberedOutcome[] = []
    const responseTimes: number[] = []
    const threadStartTime = Date.now()

    progress.currentThread = threadIndex + 1

    for (let i = 0; i < requestCount; i++) {
        const result = await executeRequest(send, spec)
        results.push({ ...result, requestNumber: i + 1, threadId: threadIndex + 1 })
        responseTimes.push(result.responseTime)
        progress.completedRequests++
    }

    return {
        threadId: threadIndex + 1,
        results,
        responseTimes,
        threadTotalTime: Date.now() - threadStartTime,
    }
}

/** The page of a response the API playground should open a WebSocket to, if it names one. */
export function wsHandoffOf(outcome: RequestOutcome): { url: string; token: string } | null {
    const data = outcome.data as Record<string, unknown> | null
    if (!outcome.success || !data || typeof data.wsUrl !== 'string') return null
    return { url: data.wsUrl, token: typeof data.wsToken === 'string' ? data.wsToken : '' }
}

/** The one response of a run of one, as the pane shows it. */
export function singleResultOf(outcome: RequestOutcome, spec: RequestSpec): TestResult {
    return {
        success: outcome.success,
        status: outcome.status,
        statusText: outcome.statusText,
        headers: outcome.headers,
        data: outcome.data,
        responseTime: outcome.responseTime,
        url: spec.url,
        method: spec.method,
        requestHeaders: spec.headers,
        requestBody: spec.body,
    }
}

/**
 * The summary of a run of many. `perRequestDivisor` is what the average divides the wall-clock
 * time by: the requests of one thread, or of all threads together.
 */
export function summaryOf(input: {
    spec: RequestSpec
    results: NumberedOutcome[]
    responseTimes: number[]
    totalTime: number
    totalRequests: number
    threads?: { threadCount: number; requestsPerThread: number; threadResults: ThreadResult[] }
}): TestResult {
    const successfulRequests = input.results.filter((result) => result.success).length
    const hasTimes = input.responseTimes.length > 0

    return {
        success: successfulRequests > 0,
        firstResult: input.results[0],
        statistics: {
            totalRequests: input.totalRequests,
            successfulRequests,
            failedRequests: input.results.length - successfulRequests,
            totalTime: input.totalTime,
            avgResponseTime: input.totalRequests > 0 ? input.totalTime / input.totalRequests : 0,
            // a run of one thread has always had at least one request; threads guard the empty case
            minResponseTime: hasTimes || !input.threads ? Math.min(...input.responseTimes) : 0,
            maxResponseTime: hasTimes || !input.threads ? Math.max(...input.responseTimes) : 0,
            ...(input.threads && {
                threadCount: input.threads.threadCount,
                requestsPerThread: input.threads.requestsPerThread,
            }),
        },
        url: input.spec.url,
        method: input.spec.method,
        requestHeaders: input.spec.headers,
        requestBody: input.spec.body,
        allResults: input.results,
        ...(input.threads && { threadResults: input.threads.threadResults }),
    }
}

/** The run threw rather than failed: show that, with what was being sent. */
export function failedRunOf(error: unknown, spec: Pick<RequestSpec, 'url' | 'method'>): TestResult {
    return {
        success: false,
        error: true,
        message: 'Network error or request failed',
        details: error instanceof Error ? error.message : 'Unknown error',
        url: spec.url,
        method: spec.method,
    }
}
