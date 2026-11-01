import { supportRepository } from '#app/repositories/index.js'
import { supportEmbeddingService } from '#app/services/support/support-embedding-service.js'
import { supportLlmService } from '#app/services/support/support-llm-service.js'
import { aiAbortKind } from '#app/services/ai/ai-request-signal.js'
import supportConfig from '#config/support.js'
import { isAppLocaleCode } from 'shared/enums'
import { supportQueryTranslationService } from '#app/services/support/support-query-translation-service.js'
import { broadcastService } from '#app/services/communication/broadcast-service.js'
import { llmUsageService } from '#app/services/ai/usage/llm-usage-service.js'
import { promptService } from '#app/services/ai/prompt-service.js'
import { Result } from 'better-result'
import type { BroadcastMessage } from 'shared/schemas'
import type { TokenUsage } from '#app/services/ai/types.js'
import logger from '#logger'
import { rateLimited, type AppResult } from '#app/services/shared/errors.js'
import { tryInternal } from '#app/services/shared/result-helpers.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'
import aiConfig from '#config/ai.js'
import { throttlePolicies, type ThrottlePolicy } from '#config/throttle-policies.js'
import { consumeAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import {
    reserveDailyTokens,
    type TokenReservation,
} from '#app/services/ai/usage/llm-budget-service.js'
import {
    BUDGET_CALLS,
    estimateSupportParts,
    reportedTokens,
} from '#app/services/support/support-budget.js'
import {
    acquireSupportLock,
    type SupportLease,
} from '#app/services/support/support-inflight-lock.js'

export interface SupportChatHistoryItem {
    id: string
    role: 'user' | 'assistant'
    content: string
    screenshots: string[] | null
    createdAt: string
}

// The UI locale the client sent, mapped to an app locale; otherwise the configured
// default (code-issues item 52 — it used to be a hard-coded 'ru').
export function resolveSupportLanguage(language: string | undefined): string {
    if (language !== undefined) {
        const base = language.trim().toLowerCase().split(/[-_]/)[0] ?? ''
        if (isAppLocaleCode(base)) return base
    }
    return supportConfig.defaultLanguage
}

function broadcastToConnection(
    userIdStr: string,
    targetUuid: string | undefined,
    ...message: BroadcastMessage
): void {
    if (targetUuid !== undefined) {
        const sent = broadcastService.broadcastMessageToUserConnection(
            userIdStr,
            targetUuid,
            ...message,
        )
        if (sent === 0) {
            broadcastService.broadcastMessageToUser(userIdStr, ...message)
        }
    } else {
        broadcastService.broadcastMessageToUser(userIdStr, ...message)
    }
}

function extractScreenshotIds(text: string): string[] {
    const ids: string[] = []
    const regex = /\[screenshot:(\d+)\]/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
        if (match[1] !== undefined) {
            ids.push(match[1])
        }
    }
    return ids
}

function formatKnowledgeContext(
    results: Awaited<ReturnType<typeof supportEmbeddingService.search>>,
): string {
    if (results.length === 0) {
        return 'No relevant articles found in the knowledge base.'
    }
    return results
        .map((r, i) => {
            const screenshotNote =
                r.screenshotKey !== null
                    ? `\n[This article has a screenshot. Use [screenshot:${String(r.id)}] to show it if relevant.]`
                    : ''
            return `--- Article ${String(i + 1)} (id: ${String(r.id)}) ---\nTitle: ${r.title}\n${r.content}${screenshotNote}`
        })
        .join('\n\n')
}

// The lock is a lease the live answer keeps renewing (see support-inflight-lock.ts), not a
// guess of how long an answer takes: the database waits of a run have no bound of their own.
// A dead process stops renewing and frees the user within `ttlMs`. A run that is still going
// after `maxLifetimeMs` (three provider calls plus a minute for the database) is abandoned.
const SUPPORT_LEASE: SupportLease = {
    ttlMs: 30_000,
    renewEveryMs: 5_000,
    maxLifetimeMs: aiConfig.requestTimeoutMs * 3 + 60_000,
}
const BUSY_RETRY_AFTER_SECONDS = 5

// How much of the conversation the model is shown. The UI reads the history in pages; this
// is a separate, fixed slice, so a long conversation does not grow the prompt (and its cost).
const SUPPORT_CONTEXT_MESSAGES = 20

/**
 * A message the server has accepted: it passed the per-user limit and holds the user's
 * lock. Whoever has one must release it, on every path (`run*` does).
 */
export interface SupportAdmission {
    /** Aborts when the lock can no longer be trusted: no further paid step may start. */
    readonly lost: AbortSignal
    /**
     * The daily token budget of this answer (ADR 0003): the run marks each paid call as
     * started right before making it and reports the usage the provider returned.
     */
    readonly budget: Pick<TokenReservation, 'begin' | 'record'>
    /** Settles the budget, then frees the lock. */
    release(): Promise<void>
}

/**
 * @param message the message to be answered; `null` for the greeting. Its length sizes the
 * budget reservation.
 */
async function admit(
    userId: bigint,
    policy: ThrottlePolicy,
    message: string | null,
): Promise<AppResult<SupportAdmission>> {
    const throttle = await tryInternal(
        () => consumeAuthThrottle(policy, String(userId)),
        'Failed to enforce the support chat limit',
    )
    if (Result.isError(throttle)) return Result.err(throttle.error)
    if (!throttle.value.allowed) {
        return Result.err(
            rateLimited('Too many messages. Please try again later.', {
                reason: 'support_rate_limited',
                retryAfterSeconds: Math.ceil(policy.windowMs / 1000),
            }),
        )
    }

    const lock = await tryInternal(
        () => acquireSupportLock(userId, SUPPORT_LEASE),
        'Failed to reserve the support chat',
    )
    if (Result.isError(lock)) return Result.err(lock.error)
    if (lock.value === null) {
        return Result.err(
            rateLimited('The previous message is still being answered. Please wait.', {
                reason: 'support_busy',
                retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS,
            }),
        )
    }

    const held = lock.value

    const releaseLock = async (): Promise<void> => {
        try {
            await held.release()
        } catch (err) {
            // The lease stops being renewed and expires on its own.
            logger.warn({ err, userId: String(userId) }, 'Support: could not release the lock')
        }
    }

    // The daily token budget, reserved last: a refusal here must give the lock back, since
    // this admission took it and no run will ever release it.
    const reserved = await tryInternal(
        () =>
            reserveDailyTokens(userId, estimateSupportParts(message), {
                limit: aiConfig.supportDailyTokenBudget,
            }),
        'Failed to enforce the support chat budget',
    )
    if (Result.isError(reserved)) {
        await releaseLock()
        return Result.err(reserved.error)
    }
    if (!reserved.value.allowed) {
        await releaseLock()
        return Result.err(
            rateLimited('The daily AI usage limit is reached. Please try again tomorrow.', {
                reason: 'support_budget_exceeded',
                retryAfterSeconds: reserved.value.retryAfterSeconds,
            }),
        )
    }

    const reservation = reserved.value.reservation
    return Result.ok({
        lost: held.lost,
        budget: reservation,
        release: async (): Promise<void> => {
            // Before the lock: the next answer of this user must find the budget settled.
            try {
                await reservation.settle()
            } catch (err) {
                logger.warn({ err, userId: String(userId) }, 'Support: could not settle the budget')
            }
            await releaseLock()
        },
    })
}

/** What a finished run tells the client, sent after the lock is released. */
type SupportOutcome =
    | { kind: 'none' }
    | { kind: 'complete'; content: string; screenshots: string[] }
    | { kind: 'error'; code: string; message: string }

/** The id the client gave the message, put on every event of its answer (absent: none sent). */
const withMessageId = (clientMessageId: string | undefined): { clientMessageId?: string } =>
    clientMessageId === undefined ? {} : { clientMessageId }

/** The run stops when the connection closes or the lock is lost, whichever comes first. */
const runSignalOf = (admission: SupportAdmission, signal: AbortSignal | undefined): AbortSignal =>
    signal === undefined ? admission.lost : AbortSignal.any([signal, admission.lost])

/** What a call reports to the budget: the tokens the provider counted, or nothing (null). */
const usageReporter =
    (admission: SupportAdmission, kind: string) =>
    (usage: TokenUsage): void => {
        admission.budget.record(kind, reportedTokens(usage))
    }

const interruptedOutcome = (): SupportOutcome => ({
    kind: 'error',
    code: 'chat_interrupted',
    message: 'The answer was interrupted. Please try again.',
})

function tellClient(
    userIdStr: string,
    targetUuid: string | undefined,
    outcome: SupportOutcome,
    clientMessageId?: string,
): void {
    try {
        if (outcome.kind === 'complete') {
            broadcastToConnection(userIdStr, targetUuid, 'support_chat_complete', {
                content: outcome.content,
                screenshots: outcome.screenshots,
                ...withMessageId(clientMessageId),
            })
        } else if (outcome.kind === 'error') {
            broadcastToConnection(userIdStr, targetUuid, 'support_chat_error', {
                message: outcome.message,
                code: outcome.code,
                ...withMessageId(clientMessageId),
            })
        }
    } catch (err) {
        // Nobody is left to tell (the connection is gone); never an unhandled rejection.
        logger.warn({ err, userId: userIdStr }, 'Support: could not tell the client the outcome')
    }
}

export const supportService = {
    /**
     * One page of the history: the `limit` messages before the cursor `before` (the id of the
     * oldest message the client has), oldest-first, and whether older ones exist. The whole
     * history is never read in one go.
     */
    async getChatHistory(
        userId: bigint,
        page: { before?: string | undefined; limit: number },
    ): Promise<AppResult<{ data: SupportChatHistoryItem[]; hasMore: boolean }>> {
        const result = await tryInternal(
            () =>
                supportRepository.findChatHistoryPage(userId, {
                    before: page.before === undefined ? undefined : BigInt(page.before),
                    limit: page.limit,
                }),
            'Failed to load chat history',
        )
        if (Result.isError(result)) {
            return Result.err(result.error)
        }

        return Result.ok({
            hasMore: result.value.hasMore,
            data: result.value.rows.map((m) => ({
                id: String(m.id),
                role: m.role,
                content: m.content,
                screenshots: (m.screenshots as string[] | null) ?? null,
                createdAt: m.createdAt.toISOString(),
            })),
        })
    },

    async deleteChatHistory(userId: bigint): Promise<AppResult<void>> {
        const result = await tryInternal(
            () => supportRepository.deleteAllChatHistory(userId),
            'Failed to delete chat history',
        )
        if (Result.isError(result)) {
            return Result.err(result.error)
        }

        return Result.ok(undefined)
    },

    /** Admits the greeting: the per-user limit for opening the chat, then the user's lock. */
    admitOpenChat(userId: bigint): Promise<AppResult<SupportAdmission>> {
        return admit(userId, throttlePolicies.supportOpenChatUser, null)
    },

    /**
     * Admits a message: the per-user limit, the user's lock (one answer at a time), then the
     * daily token budget.
     */
    admitChat(userId: bigint, message: string): Promise<AppResult<SupportAdmission>> {
        return admit(userId, throttlePolicies.supportChatUser, message)
    },

    /**
     * Writes the greeting for an admitted request and releases the lock on every path,
     * before the client is told the answer is complete or has failed: a client that sends
     * its next message at once must not find the lock still held.
     */
    async runOpenChat(
        admission: SupportAdmission,
        userId: bigint,
        targetUuid?: string,
        signal?: AbortSignal,
        language?: string,
    ): Promise<void> {
        const userIdStr = String(userId)
        const runSignal = runSignalOf(admission, signal)
        let outcome: SupportOutcome = { kind: 'none' }
        try {
            // Before every step that costs money: a run that resumes after its lock was
            // lost must not start a second answer next to the one that took the lock over.
            runSignal.throwIfAborted()
            const langNative = resolveSupportLanguage(language)
            const hasHistory = await supportRepository.hasChatHistory(userId)
            runSignal.throwIfAborted()
            if (!hasHistory) {
                const promptId = promptService.get('SUPPORT_FIRST_CHAT')?.id ?? null

                let fullReply = ''
                admission.budget.begin(BUDGET_CALLS.chat)
                for await (const token of supportLlmService.openChatStream(
                    langNative,
                    llmUsageService.textUsageRecorder(
                        'SUPPORT_CHAT',
                        userId,
                        promptId,
                        usageReporter(admission, BUDGET_CALLS.chat),
                    ),
                    runSignal,
                )) {
                    // Nothing of a run reaches the client once its lock is lost: the events
                    // would mix with the answer of the request that took the lock over.
                    admission.lost.throwIfAborted()
                    fullReply += token
                    broadcastToConnection(userIdStr, targetUuid, 'support_chat_token', { token })
                }

                runSignal.throwIfAborted()
                if (fullReply.length > 0) {
                    await supportRepository.addChatMessage(userId, 'assistant', fullReply)
                }
                admission.lost.throwIfAborted()
                outcome = { kind: 'complete', content: fullReply, screenshots: [] }
            }
        } catch (err) {
            if (admission.lost.aborted) {
                logger.warn({ err, userId: userIdStr }, 'Support: openChat stopped, lock was lost')
                outcome = interruptedOutcome()
            } else if (aiAbortKind(err) === 'aborted') {
                // The connection closed: nobody to answer, and not a failure.
                logger.info({ userId: userIdStr }, 'Support: openChat cancelled, connection closed')
            } else {
                logger.error({ err, userId: userIdStr }, 'Support: openChat failed')
                outcome = {
                    kind: 'error',
                    code: 'open_chat_failed',
                    message: 'Failed to open support chat',
                }
            }
        }

        await admission.release()
        tellClient(userIdStr, targetUuid, outcome)
    },

    /** The answer to an admitted message; the lock is released as in `runOpenChat`. */
    async runChat(
        admission: SupportAdmission,
        userId: bigint,
        message: string,
        targetUuid?: string,
        signal?: AbortSignal,
        language?: string,
        clientMessageId?: string,
    ): Promise<void> {
        const userIdStr = String(userId)
        const runSignal = runSignalOf(admission, signal)
        let outcome: SupportOutcome = { kind: 'none' }
        try {
            // See runOpenChat: checked before every step that costs money.
            runSignal.throwIfAborted()
            const langNative = resolveSupportLanguage(language)
            const { stored } = await supportRepository.addUserMessageOnce(
                userId,
                message,
                clientMessageId,
            )
            runSignal.throwIfAborted()
            if (!stored) {
                // A resend of a message the server already has: it was answered, is being
                // answered, or its answer was lost. Answering it again would double the
                // reply, so the client is told and reads the history.
                outcome = {
                    kind: 'error',
                    code: 'message_already_received',
                    message: 'This message was already received.',
                }
                await admission.release()
                tellClient(userIdStr, targetUuid, outcome, clientMessageId)
                return
            }

            admission.budget.begin(BUDGET_CALLS.translation)
            const [englishQuery, chatHistory] = await Promise.all([
                supportQueryTranslationService.translateToEnglish(message, {
                    userId,
                    signal: runSignal,
                    onUsage: usageReporter(admission, BUDGET_CALLS.translation),
                }),
                supportRepository.findRecentForContext(userId, SUPPORT_CONTEXT_MESSAGES),
            ])
            runSignal.throwIfAborted()

            admission.budget.begin(BUDGET_CALLS.embedding)
            const searchResults = await supportEmbeddingService.search(englishQuery, 5, {
                userId,
                signal: runSignal,
                onUsage: usageReporter(admission, BUDGET_CALLS.embedding),
            })
            runSignal.throwIfAborted()
            const knowledgeContext = formatKnowledgeContext(searchResults)
            const promptId = promptService.get('SUPPORT_SYSTEM')?.id ?? null

            let fullReply = ''
            admission.budget.begin(BUDGET_CALLS.chat)
            for await (const token of supportLlmService.chatStream(
                message,
                knowledgeContext,
                chatHistory.filter((m) => m.role !== 'user' || m.content !== message),
                langNative,
                llmUsageService.textUsageRecorder(
                    'SUPPORT_CHAT',
                    userId,
                    promptId,
                    usageReporter(admission, BUDGET_CALLS.chat),
                ),
                runSignal,
            )) {
                admission.lost.throwIfAborted()
                fullReply += token
                broadcastToConnection(userIdStr, targetUuid, 'support_chat_token', {
                    token,
                    ...withMessageId(clientMessageId),
                })
            }

            runSignal.throwIfAborted()
            const screenshotIds = extractScreenshotIds(fullReply)

            await supportRepository.addChatMessage(userId, 'assistant', fullReply, screenshotIds)
            // The save may have taken long: a run that lost its lock meanwhile tells nobody
            // (the notification and the "complete" event belong to the current owner).
            admission.lost.throwIfAborted()
            userNotificationService.supportReply(userId)

            outcome = { kind: 'complete', content: fullReply, screenshots: screenshotIds }
        } catch (err) {
            if (admission.lost.aborted) {
                logger.warn({ err, userId: userIdStr }, 'Support: chat stopped, lock was lost')
                outcome = interruptedOutcome()
            } else if (aiAbortKind(err) === 'aborted') {
                logger.info({ userId: userIdStr }, 'Support: chat cancelled, connection closed')
            } else {
                logger.error({ err, userId: userIdStr }, 'Support: chat failed')
                outcome = { kind: 'error', code: 'chat_failed', message: 'Chat failed' }
            }
        }

        await admission.release()
        tellClient(userIdStr, targetUuid, outcome, clientMessageId)
    },
}
