import { aiAbortKind } from '#app/services/ai/ai-request-signal.js'
import { buildFinalTextPrompt } from '#app/services/ai/types.js'
import type {
    ITextAdapter,
    TextCallStatus,
    TextStreamOptions,
    TextUsageCompleteHandler,
    TokenUsage,
    UsageReportDetails,
} from '#app/services/ai/types.js'
import { estimatedUsage, hasReportedUsage } from '#app/services/ai/usage/token-estimate.js'
import logger from '#logger'

// feat-118 (R12b): every provider call that started is in the usage log, however it ended.
//
// - Started: the first step of the stream, i.e. the request is on its way. In the support pipeline
//   that step comes right after `admission.budget.begin(call)` (ADR 0003), so the audit and the
//   budget agree on which calls cost something; a stream never iterated writes nothing.
// - One report per call: completion, a provider error, a timeout and the consumer stopping (the
//   connection closed, the lock lost) all go through one `settle`; later ones are no-ops.
// - Status and token origin are independent: usage the provider reported (also before an abort) is
//   real; without it the tokens are an estimate (prompt and streamed text, characters / 2) and the
//   row says so.

/**
 * `aborted` when the caller cancelled; a timeout or any other error is `failed`.
 *
 * feat-121 (M2): the caller's signal decides, not the error's name. A lost support lock cancels
 * with its own reason (SupportLockLostError), and fetch rejects with that reason as it is, so the
 * name says nothing; the timeout lives on the adapter's own signal (aiRequestSignal), not on the
 * caller's, and stays `failed`.
 */
export const statusOfError = (error: unknown, callerSignal?: AbortSignal): TextCallStatus => {
    if (callerSignal?.aborted === true) return 'aborted'
    return aiAbortKind(error) === 'aborted' ? 'aborted' : 'failed'
}

export interface CallAudit {
    /**
     * Usage the provider reported so far; the last report wins. `partial` usage (feat-136, L7) is
     * real but covers only part of the call: the call is then recorded as estimated.
     */
    keep(usage: TokenUsage, details?: UsageReportDetails): void
    /** Writes the call's one report; a second call does nothing. */
    settle(status: TextCallStatus, outputChars: number | null): void
}

/** feat-136: the larger of each count, so an estimate never falls below what was reported. */
function atLeast(reported: TokenUsage, estimate: TokenUsage): TokenUsage {
    const max = (a: number | null, b: number | null): number | null =>
        a === null ? b : b === null ? a : Math.max(a, b)
    return {
        promptTokens: max(reported.promptTokens, estimate.promptTokens),
        completionTokens: max(reported.completionTokens, estimate.completionTokens),
        totalTokens: max(reported.totalTokens, estimate.totalTokens),
    }
}

export function auditCall(
    onComplete: TextUsageCompleteHandler,
    model: string,
    finalPrompt: string,
    estimateFrom: string = finalPrompt,
): CallAudit {
    let reported: TokenUsage | null = null
    let partial = false
    let settled = false
    return {
        keep(usage, details): void {
            if (!hasReportedUsage(usage)) return
            reported = usage
            partial = details?.partial === true
        },
        settle(status, outputChars): void {
            if (settled) return
            settled = true
            const estimate = estimatedUsage(estimateFrom, outputChars)
            const tokensEstimated = reported === null || partial
            const usage =
                reported === null ? estimate : partial ? atLeast(reported, estimate) : reported
            try {
                onComplete(usage, model, finalPrompt, { status, tokensEstimated })
            } catch (err: unknown) {
                logger.warn({ err }, 'LLM usage audit: the usage handler failed')
            }
        },
    }
}

async function* auditedStream(
    adapter: ITextAdapter,
    opts: TextStreamOptions,
    onComplete: TextUsageCompleteHandler,
): AsyncGenerator<string, string, undefined> {
    const audit = auditCall(
        onComplete,
        opts.modelOverride ?? adapter.model,
        buildFinalTextPrompt(opts),
    )
    let outputChars = 0
    const inner = adapter.streamText(
        {
            ...opts,
            onUsageReported: (usage, details) => {
                audit.keep(usage, details)
                // The budget settles on real usage of the whole call only; a part keeps the
                // reservation (feat-136).
                if (details?.partial !== true) opts.onUsageReported?.(usage, details)
            },
        },
        (usage) => {
            audit.keep(usage)
        },
    )
    let ended = false
    try {
        for (;;) {
            const step = await inner.next()
            if (step.done === true) {
                ended = true
                audit.settle('completed', outputChars)
                return step.value
            }
            outputChars += step.value.length
            yield step.value
        }
    } catch (err: unknown) {
        ended = true
        audit.settle(statusOfError(err, opts.signal), outputChars)
        throw err
    } finally {
        if (!ended) {
            // The consumer stopped reading (connection closed, lock lost): the call is aborted,
            // and the provider stream is closed with it.
            audit.settle('aborted', outputChars)
            try {
                await inner.return(undefined as never)
            } catch (err: unknown) {
                logger.debug({ err }, 'LLM usage audit: closing an abandoned stream failed')
            }
        }
    }
}

/**
 * The adapter with the usage audit around every call that has a usage handler. A call to an
 * adapter that is not configured fails before any request and is not audited.
 */
export function withUsageAudit(adapter: ITextAdapter): ITextAdapter {
    return {
        isConfigured: () => adapter.isConfigured(),
        get model(): string {
            return adapter.model
        },
        streamText(opts, onComplete): AsyncGenerator<string, string, undefined> {
            if (onComplete === undefined || !adapter.isConfigured()) {
                return adapter.streamText(opts, onComplete)
            }
            return auditedStream(adapter, opts, onComplete)
        },
    }
}
