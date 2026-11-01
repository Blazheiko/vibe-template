import { Result } from 'better-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import aiConfig from '#config/ai.js'
import { throttlePolicies } from '#config/throttle-policies.js'

const supportRepositoryMock = {
    findChatHistory: vi.fn(),
    deleteAllChatHistory: vi.fn(),
    addChatMessage: vi.fn(),
    addUserMessageOnce: vi.fn(),
}

const supportEmbeddingServiceMock = {
    search: vi.fn(),
}

const supportLlmServiceMock = {
    openChatStream: vi.fn(),
    chatStream: vi.fn(),
}

const supportQueryTranslationServiceMock = {
    translateToEnglish: vi.fn(),
}

const broadcastServiceMock = {
    broadcastMessageToUser: vi.fn(),
    broadcastMessageToUserConnection: vi.fn(),
}

const llmUsageServiceMock = {
    recordText: vi.fn(),
    textUsageRecorder: vi.fn(() => vi.fn()),
}

const promptServiceMock = {
    get: vi.fn(() => ({ id: 'prompt-id' })),
}

const loggerMock = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}

const userNotificationServiceMock = {
    supportReply: vi.fn(),
}

const consumeAuthThrottleMock = vi.fn()
const acquireSupportLockMock = vi.fn()

vi.mock('#app/repositories/support/support-repository.js', () => ({
    supportRepository: supportRepositoryMock,
}))

vi.mock('#app/services/support/support-embedding-service.js', () => ({
    supportEmbeddingService: supportEmbeddingServiceMock,
}))

vi.mock('#app/services/support/support-llm-service.js', () => ({
    supportLlmService: supportLlmServiceMock,
}))

vi.mock('#app/services/support/support-query-translation-service.js', () => ({
    supportQueryTranslationService: supportQueryTranslationServiceMock,
}))

vi.mock('#app/services/communication/broadcast-service.js', () => ({
    broadcastService: broadcastServiceMock,
}))

vi.mock('#app/services/ai/usage/llm-usage-service.js', () => ({
    llmUsageService: llmUsageServiceMock,
}))

vi.mock('#app/services/ai/prompt-service.js', () => ({
    promptService: promptServiceMock,
}))

vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: userNotificationServiceMock,
}))

vi.mock('#logger', () => ({
    default: loggerMock,
}))

vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
}))

vi.mock('#app/services/support/support-inflight-lock.js', () => ({
    acquireSupportLock: acquireSupportLockMock,
}))

// What a run needs from its admission, recording when the lock is released.
const admissionOf = (order: string[] = [], lostController = new AbortController()) => ({
    lost: lostController.signal,
    release: vi.fn(() => {
        order.push('release')
        return Promise.resolve()
    }),
})

// A lease that was lost: another answer may be running now (the cause is the lease, not a
// closed connection, so the run must say so instead of going quiet).
const lostLease = (): AbortController => {
    const controller = new AbortController()
    const lost = new Error('The support lock was lost')
    lost.name = 'SupportLockLostError'
    controller.abort(lost)
    return controller
}

async function loadSupportService() {
    return import('./support-service.js')
}

beforeEach(() => {
    supportRepositoryMock.addUserMessageOnce.mockResolvedValue({ stored: true })
})

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

describe('supportService', () => {
    it('returns mapped chat history', async () => {
        supportRepositoryMock.findChatHistory.mockResolvedValue([
            {
                id: 1n,
                role: 'assistant',
                content: 'Hello',
                screenshots: ['1', '2'],
                createdAt: new Date('2026-05-08T10:00:00.000Z'),
            },
        ])

        const { supportService } = await loadSupportService()
        const result = await supportService.getChatHistory(11n)

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                data: [
                    {
                        id: '1',
                        role: 'assistant',
                        content: 'Hello',
                        screenshots: ['1', '2'],
                        createdAt: '2026-05-08T10:00:00.000Z',
                    },
                ],
            })
        }
    })

    it('returns internal error when deleting chat history fails', async () => {
        supportRepositoryMock.deleteAllChatHistory.mockRejectedValue(new Error('db down'))

        const { supportService } = await loadSupportService()
        const result = await supportService.deleteChatHistory(11n)

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'Internal',
                publicMessage: 'Failed to delete chat history',
                cause: expect.any(Error),
            })
        }
    })

    describe('cancellation when the WS connection closes (code-issues item 51)', () => {
        const abortingStream = async function* (): AsyncGenerator<string, void, undefined> {
            yield 'partial'
            throw new DOMException('closed', 'AbortError')
        }

        it('forwards the connection signal and does not report a closed connection as a failure', async () => {
            supportRepositoryMock.addChatMessage.mockResolvedValue(undefined)
            supportRepositoryMock.findChatHistory.mockResolvedValue([])
            supportQueryTranslationServiceMock.translateToEnglish.mockResolvedValue('hello')
            supportEmbeddingServiceMock.search.mockResolvedValue([])
            supportLlmServiceMock.chatStream.mockImplementation(abortingStream)
            const controller = new AbortController()

            const { supportService } = await loadSupportService()
            await supportService.runChat(admissionOf(), 7n, 'hello', 'conn-1', controller.signal)

            // Not the same object any more (it is combined with the lock's), but it follows it.
            const passed = supportLlmServiceMock.chatStream.mock.calls[0]?.at(-1) as AbortSignal
            expect(passed.aborted).toBe(false)
            controller.abort()
            expect(passed.aborted).toBe(true)
            expect(loggerMock.error).not.toHaveBeenCalled()
            const events = broadcastServiceMock.broadcastMessageToUserConnection.mock.calls.map(
                (call) => JSON.stringify(call),
            )
            // The partial token was streamed (so the spy sees this connection's events)…
            expect(events.some((event) => event.includes('support_chat_token'))).toBe(true)
            // …but the abort produced no error event.
            expect(events.some((event) => event.includes('support_chat_error'))).toBe(false)
            expect(supportRepositoryMock.addUserMessageOnce).toHaveBeenCalledTimes(1)
            expect(supportRepositoryMock.addChatMessage).not.toHaveBeenCalled()
        })

        it('openChat forwards the signal and stays quiet when aborted', async () => {
            supportRepositoryMock.findChatHistory.mockResolvedValue([])
            supportLlmServiceMock.openChatStream.mockImplementation(abortingStream)
            const controller = new AbortController()

            const { supportService } = await loadSupportService()
            await supportService.runOpenChat(admissionOf(), 7n, 'conn-1', controller.signal)

            const passed = supportLlmServiceMock.openChatStream.mock.calls[0]?.at(-1) as AbortSignal
            expect(passed.aborted).toBe(false)
            controller.abort()
            expect(passed.aborted).toBe(true)
            expect(loggerMock.error).not.toHaveBeenCalled()
        })
    })

    // Review of #208: a resend after a lost answer must not duplicate the message, and the
    // events of an answer say which message they belong to.
    describe('the client message id', () => {
        const tellOrder = () => {
            const events: { event: string; payload: unknown }[] = []
            broadcastServiceMock.broadcastMessageToUserConnection.mockImplementation(
                (_user: string, _uuid: string, event: string, payload: unknown) => {
                    events.push({ event, payload })
                    return 1
                },
            )
            return events
        }

        it('stores the message under its id and puts the id on every event of the answer', async () => {
            supportRepositoryMock.findChatHistory.mockResolvedValue([])
            supportQueryTranslationServiceMock.translateToEnglish.mockResolvedValue('hello')
            supportEmbeddingServiceMock.search.mockResolvedValue([])
            supportLlmServiceMock.chatStream.mockImplementation(async function* () {
                yield 'a'
            })
            supportRepositoryMock.addChatMessage.mockResolvedValue(undefined)
            const events = tellOrder()

            const { supportService } = await loadSupportService()
            await supportService.runChat(
                admissionOf(),
                7n,
                'hello',
                'conn-1',
                undefined,
                undefined,
                'msg-1',
            )

            expect(supportRepositoryMock.addUserMessageOnce).toHaveBeenCalledWith(
                7n,
                'hello',
                'msg-1',
            )
            expect(events.map((e) => e.event)).toEqual([
                'support_chat_token',
                'support_chat_complete',
            ])
            for (const { payload } of events) {
                expect(payload).toMatchObject({ clientMessageId: 'msg-1' })
            }
        })

        it('does not answer a message it already has: tells the client, runs no provider call, releases the lock', async () => {
            supportRepositoryMock.addUserMessageOnce.mockResolvedValue({ stored: false })
            const events = tellOrder()
            const admission = admissionOf()

            const { supportService } = await loadSupportService()
            await supportService.runChat(
                admission,
                7n,
                'hello',
                'conn-1',
                undefined,
                undefined,
                'msg-1',
            )

            expect(supportQueryTranslationServiceMock.translateToEnglish).not.toHaveBeenCalled()
            expect(supportLlmServiceMock.chatStream).not.toHaveBeenCalled()
            expect(admission.release).toHaveBeenCalledTimes(1)
            expect(events).toEqual([
                {
                    event: 'support_chat_error',
                    payload: {
                        message: 'This message was already received.',
                        code: 'message_already_received',
                        clientMessageId: 'msg-1',
                    },
                },
            ])
        })

        it('puts the id on the error event of a failed answer as well', async () => {
            supportRepositoryMock.findChatHistory.mockRejectedValue(new Error('db down'))
            supportQueryTranslationServiceMock.translateToEnglish.mockResolvedValue('x')
            const events = tellOrder()

            const { supportService } = await loadSupportService()
            await supportService.runChat(
                admissionOf(),
                7n,
                'hello',
                'conn-1',
                undefined,
                undefined,
                'msg-1',
            )

            expect(events[0]?.payload).toMatchObject({
                code: 'chat_failed',
                clientMessageId: 'msg-1',
            })
        })

        it('leaves the id off the events when the client sent none', async () => {
            supportRepositoryMock.findChatHistory.mockResolvedValue([])
            supportQueryTranslationServiceMock.translateToEnglish.mockResolvedValue('hello')
            supportEmbeddingServiceMock.search.mockResolvedValue([])
            supportLlmServiceMock.chatStream.mockImplementation(async function* () {
                yield 'a'
            })
            supportRepositoryMock.addChatMessage.mockResolvedValue(undefined)
            const events = tellOrder()

            const { supportService } = await loadSupportService()
            await supportService.runChat(admissionOf(), 7n, 'hello', 'conn-1')

            for (const { payload } of events) expect(payload).not.toHaveProperty('clientMessageId')
        })
    })

    describe('answer language (code-issues item 52)', () => {
        it.each([
            ['uk', 'uk'],
            ['pt-BR', 'pt'],
            ['  DE ', 'de'],
            ['klingon', 'en'],
            [undefined, 'en'],
        ])('resolves %j to %j', async (language, expected) => {
            const { resolveSupportLanguage } = await loadSupportService()
            expect(resolveSupportLanguage(language)).toBe(expected)
        })

        it('passes the resolved language to the LLM instead of a hard-coded one', async () => {
            supportRepositoryMock.findChatHistory.mockResolvedValue([])
            supportLlmServiceMock.openChatStream.mockImplementation(async function* () {
                yield 'hi'
            })

            const { supportService } = await loadSupportService()
            await supportService.runOpenChat(admissionOf(), 7n, 'conn-1', undefined, 'uk')

            expect(supportLlmServiceMock.openChatStream.mock.calls[0]?.[0]).toBe('uk')
        })
    })
    describe('admission (feat-063)', () => {
        it('admits a message that is within the limit and gets the lock, with the chat policy', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            const release = vi.fn().mockResolvedValue(true)
            acquireSupportLockMock.mockResolvedValue({
                release,
                lost: new AbortController().signal,
            })

            const { supportService } = await loadSupportService()
            const result = await supportService.admitChat(7n)

            expect(Result.isOk(result)).toBe(true)
            expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
                throttlePolicies.supportChatUser,
                '7',
            )
            // A short lease the live answer keeps renewing, and a ceiling on the whole answer
            // (three provider calls and the database) after which the lease is abandoned.
            expect(acquireSupportLockMock).toHaveBeenCalledWith(7n, {
                ttlMs: 30_000,
                renewEveryMs: 5_000,
                maxLifetimeMs: aiConfig.requestTimeoutMs * 3 + 60_000,
            })
        })

        it('uses the opening policy for the greeting', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            acquireSupportLockMock.mockResolvedValue({
                release: vi.fn(),
                lost: new AbortController().signal,
            })

            const { supportService } = await loadSupportService()
            await supportService.admitOpenChat(7n)

            expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
                throttlePolicies.supportOpenChatUser,
                '7',
            )
        })

        it('refuses a message over the per-user limit before touching the lock', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 21 })

            const { supportService } = await loadSupportService()
            const result = await supportService.admitChat(7n)

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) {
                expect(result.error).toMatchObject({
                    _tag: 'RateLimited',
                    reason: 'support_rate_limited',
                    retryAfterSeconds: 60,
                })
            }
            expect(acquireSupportLockMock).not.toHaveBeenCalled()
        })

        it('refuses a message while the previous answer holds the lock', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            acquireSupportLockMock.mockResolvedValue(null)

            const { supportService } = await loadSupportService()
            const result = await supportService.admitChat(7n)

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) {
                expect(result.error).toMatchObject({
                    _tag: 'RateLimited',
                    reason: 'support_busy',
                })
            }
        })

        it('refuses when the limit cannot be checked, without taking the lock', async () => {
            consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))

            const { supportService } = await loadSupportService()
            const result = await supportService.admitChat(7n)

            expect(Result.isError(result)).toBe(true)
            expect(acquireSupportLockMock).not.toHaveBeenCalled()
        })

        // The throttle uses its own Redis connection and throws plain ioredis errors.
        it.each(['Command timed out', 'Connection is closed.'])(
            'answers 503, not 500, when the limit cannot be checked because Redis is down ("%s")',
            async (message) => {
                consumeAuthThrottleMock.mockRejectedValue(new Error(message))

                const { supportService } = await loadSupportService()
                const result = await supportService.admitChat(7n)

                expect(Result.isError(result) && result.error._tag).toBe('ServiceUnavailable')
                expect(acquireSupportLockMock).not.toHaveBeenCalled()
            },
        )

        it('answers 503 when the lock cannot be taken because Redis is down', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            acquireSupportLockMock.mockRejectedValue(new Error('Command timed out'))

            const { supportService } = await loadSupportService()
            const result = await supportService.admitChat(7n)

            expect(Result.isError(result) && result.error._tag).toBe('ServiceUnavailable')
        })

        it('refuses when the lock cannot be taken', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            acquireSupportLockMock.mockRejectedValue(new Error('redis down'))

            const { supportService } = await loadSupportService()

            expect(Result.isError(await supportService.admitChat(7n))).toBe(true)
        })

        it('release frees the lock, and a failing release is logged, not raised', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            const release = vi.fn().mockRejectedValue(new Error('redis down'))
            acquireSupportLockMock.mockResolvedValue({
                release,
                lost: new AbortController().signal,
            })

            const { supportService } = await loadSupportService()
            const result = await supportService.admitChat(7n)
            if (!Result.isOk(result)) throw new Error('not admitted')

            await expect(result.value.release()).resolves.toBeUndefined()

            expect(release).toHaveBeenCalledTimes(1)
            expect(loggerMock.warn).toHaveBeenCalled()
        })
    })

    describe('a run releases the lock before it tells the client (feat-063)', () => {
        const tellOrder = (order: string[]) => {
            broadcastServiceMock.broadcastMessageToUserConnection.mockImplementation(
                (_user: string, _uuid: string, event: string) => {
                    order.push(event)
                    return 1
                },
            )
        }

        it('chat: tokens, then the release, then the complete event', async () => {
            const order: string[] = []
            tellOrder(order)
            supportRepositoryMock.addChatMessage.mockResolvedValue(undefined)
            supportRepositoryMock.findChatHistory.mockResolvedValue([])
            supportQueryTranslationServiceMock.translateToEnglish.mockResolvedValue('hello')
            supportEmbeddingServiceMock.search.mockResolvedValue([])
            supportLlmServiceMock.chatStream.mockImplementation(async function* () {
                yield 'a'
                yield 'b'
            })
            const admission = admissionOf(order)

            const { supportService } = await loadSupportService()
            await supportService.runChat(admission, 7n, 'hello', 'conn-1')

            expect(order).toEqual([
                'support_chat_token',
                'support_chat_token',
                'release',
                'support_chat_complete',
            ])
            expect(admission.release).toHaveBeenCalledTimes(1)
        })

        it('chat failure: the release, then support_chat_error with a code', async () => {
            const order: string[] = []
            tellOrder(order)
            supportRepositoryMock.addChatMessage.mockResolvedValue(undefined)
            supportRepositoryMock.findChatHistory.mockResolvedValue([])
            supportQueryTranslationServiceMock.translateToEnglish.mockRejectedValue(
                new Error('provider down'),
            )
            const admission = admissionOf(order)

            const { supportService } = await loadSupportService()
            await supportService.runChat(admission, 7n, 'hello', 'conn-1')

            expect(order).toEqual(['release', 'support_chat_error'])
            expect(broadcastServiceMock.broadcastMessageToUserConnection).toHaveBeenCalledWith(
                '7',
                'conn-1',
                'support_chat_error',
                { message: 'Chat failed', code: 'chat_failed' },
            )
        })

        it('openChat failure: the release, then support_chat_error with its own code', async () => {
            const order: string[] = []
            tellOrder(order)
            supportRepositoryMock.findChatHistory.mockRejectedValue(new Error('db down'))
            const admission = admissionOf(order)

            const { supportService } = await loadSupportService()
            await supportService.runOpenChat(admission, 7n, 'conn-1')

            expect(order).toEqual(['release', 'support_chat_error'])
            expect(broadcastServiceMock.broadcastMessageToUserConnection).toHaveBeenCalledWith(
                '7',
                'conn-1',
                'support_chat_error',
                { message: 'Failed to open support chat', code: 'open_chat_failed' },
            )
        })

        it('releases once and says nothing when the connection closed (abort)', async () => {
            const order: string[] = []
            tellOrder(order)
            supportRepositoryMock.addChatMessage.mockResolvedValue(undefined)
            supportRepositoryMock.findChatHistory.mockResolvedValue([])
            supportQueryTranslationServiceMock.translateToEnglish.mockRejectedValue(
                new DOMException('closed', 'AbortError'),
            )
            const admission = admissionOf(order)

            const { supportService } = await loadSupportService()
            await supportService.runChat(admission, 7n, 'hello', 'conn-1')

            expect(order).toEqual(['release'])
            expect(admission.release).toHaveBeenCalledTimes(1)
        })

        // The review of feat-063: the database waits of a run are not bounded by the provider
        // timeout, so a run can resume after its lock was lost. It must not start the next
        // paid step then, or two answers stream at once.
        describe('a run whose lock was lost', () => {
            it('chat: stops before any paid call, saves no answer, tells the client', async () => {
                const order: string[] = []
                tellOrder(order)
                const lost = new AbortController()
                supportRepositoryMock.addChatMessage.mockResolvedValue(undefined)
                // The lock is lost while the history is still being read.
                supportRepositoryMock.findChatHistory.mockImplementation(() => {
                    lost.abort(lostLease().signal.reason)
                    return Promise.resolve([])
                })
                supportQueryTranslationServiceMock.translateToEnglish.mockResolvedValue('hello')
                const admission = admissionOf(order, lost)

                const { supportService } = await loadSupportService()
                await supportService.runChat(admission, 7n, 'hello', 'conn-1')

                expect(supportEmbeddingServiceMock.search).not.toHaveBeenCalled()
                expect(supportLlmServiceMock.chatStream).not.toHaveBeenCalled()
                expect(supportRepositoryMock.addUserMessageOnce).toHaveBeenCalledTimes(1)
                expect(supportRepositoryMock.addChatMessage).not.toHaveBeenCalled()
                expect(order).toEqual(['release', 'support_chat_error'])
                expect(broadcastServiceMock.broadcastMessageToUserConnection).toHaveBeenCalledWith(
                    '7',
                    'conn-1',
                    'support_chat_error',
                    {
                        message: 'The answer was interrupted. Please try again.',
                        code: 'chat_interrupted',
                    },
                )
            })

            it('chat: does not even start when the lock was lost on admission', async () => {
                const admission = admissionOf([], lostLease())

                const { supportService } = await loadSupportService()
                await supportService.runChat(admission, 7n, 'hello', 'conn-1')

                expect(supportRepositoryMock.addUserMessageOnce).not.toHaveBeenCalled()
                expect(supportQueryTranslationServiceMock.translateToEnglish).not.toHaveBeenCalled()
            })

            it('chat: the lost lock reaches the provider calls as their abort signal', async () => {
                const lost = new AbortController()
                supportRepositoryMock.addChatMessage.mockResolvedValue(undefined)
                supportRepositoryMock.findChatHistory.mockResolvedValue([])
                supportQueryTranslationServiceMock.translateToEnglish.mockResolvedValue('hello')
                supportEmbeddingServiceMock.search.mockResolvedValue([])
                let streamSignal: AbortSignal | undefined
                supportLlmServiceMock.chatStream.mockImplementation(async function* (
                    ...args: unknown[]
                ) {
                    streamSignal = args[5] as AbortSignal
                    yield 'a'
                    lost.abort(lostLease().signal.reason)
                    yield 'b'
                })
                const admission = admissionOf([], lost)

                const { supportService } = await loadSupportService()
                await supportService.runChat(admission, 7n, 'hello', 'conn-1')

                expect(streamSignal?.aborted).toBe(true)
                // Not saved: the answer was cut off by the lock, not completed.
                expect(supportRepositoryMock.addChatMessage).not.toHaveBeenCalled()
            })

            it('chat: a closed connection still goes quiet when the lock is fine', async () => {
                // The existing behaviour: abort of the connection is not a failure.
                const controller = new AbortController()
                supportRepositoryMock.addChatMessage.mockResolvedValue(undefined)
                supportRepositoryMock.findChatHistory.mockResolvedValue([])
                supportQueryTranslationServiceMock.translateToEnglish.mockImplementation(() => {
                    controller.abort()
                    return Promise.reject(new DOMException('aborted', 'AbortError'))
                })

                const { supportService } = await loadSupportService()
                await supportService.runChat(
                    admissionOf(),
                    7n,
                    'hello',
                    'conn-1',
                    controller.signal,
                )

                expect(broadcastServiceMock.broadcastMessageToUserConnection).not.toHaveBeenCalled()
            })

            // Review of #208: after the lock is lost nothing of this run may reach the client or
            // the user: a late event could end the answer of the request that took the lock over.
            it('chat: sends no token after the lock was lost', async () => {
                const lost = new AbortController()
                supportRepositoryMock.findChatHistory.mockResolvedValue([])
                supportQueryTranslationServiceMock.translateToEnglish.mockResolvedValue('hello')
                supportEmbeddingServiceMock.search.mockResolvedValue([])
                // A provider that does not look at the signal keeps producing tokens.
                supportLlmServiceMock.chatStream.mockImplementation(async function* () {
                    yield 'a'
                    lost.abort(lostLease().signal.reason)
                    yield 'b'
                    yield 'c'
                })
                const order: string[] = []
                tellOrder(order)

                const { supportService } = await loadSupportService()
                await supportService.runChat(admissionOf(order, lost), 7n, 'hello', 'conn-1')

                expect(order).toEqual(['support_chat_token', 'release', 'support_chat_error'])
            })

            it('chat: tells nobody "complete" and notifies nobody when the lock was lost while the answer was being saved', async () => {
                const lost = new AbortController()
                supportRepositoryMock.findChatHistory.mockResolvedValue([])
                supportQueryTranslationServiceMock.translateToEnglish.mockResolvedValue('hello')
                supportEmbeddingServiceMock.search.mockResolvedValue([])
                supportLlmServiceMock.chatStream.mockImplementation(async function* () {
                    yield 'answer'
                })
                // The INSERT of the answer is still running when the lock is lost.
                supportRepositoryMock.addChatMessage.mockImplementation(() => {
                    lost.abort(lostLease().signal.reason)
                    return Promise.resolve(undefined)
                })
                const order: string[] = []
                tellOrder(order)

                const { supportService } = await loadSupportService()
                await supportService.runChat(admissionOf(order, lost), 7n, 'hello', 'conn-1')

                expect(userNotificationServiceMock.supportReply).not.toHaveBeenCalled()
                expect(order).not.toContain('support_chat_complete')
                expect(order).toEqual(['support_chat_token', 'release', 'support_chat_error'])
            })

            it('openChat: sends no token after the lock was lost', async () => {
                const lost = new AbortController()
                supportRepositoryMock.findChatHistory.mockResolvedValue([])
                supportLlmServiceMock.openChatStream.mockImplementation(async function* () {
                    yield 'a'
                    lost.abort(lostLease().signal.reason)
                    yield 'b'
                })
                const order: string[] = []
                tellOrder(order)

                const { supportService } = await loadSupportService()
                await supportService.runOpenChat(admissionOf(order, lost), 7n, 'conn-1')

                expect(order).toEqual(['support_chat_token', 'release', 'support_chat_error'])
                expect(supportRepositoryMock.addChatMessage).not.toHaveBeenCalled()
            })

            it('openChat: stops before the model call and tells the client', async () => {
                const order: string[] = []
                tellOrder(order)
                const lost = new AbortController()
                supportRepositoryMock.findChatHistory.mockImplementation(() => {
                    lost.abort(lostLease().signal.reason)
                    return Promise.resolve([])
                })
                const admission = admissionOf(order, lost)

                const { supportService } = await loadSupportService()
                await supportService.runOpenChat(admission, 7n, 'conn-1')

                expect(supportLlmServiceMock.openChatStream).not.toHaveBeenCalled()
                expect(order).toEqual(['release', 'support_chat_error'])
            })
        })

        it('openChat with an existing history writes nothing and still releases', async () => {
            const order: string[] = []
            tellOrder(order)
            supportRepositoryMock.findChatHistory.mockResolvedValue([{ id: 1n }])
            const admission = admissionOf(order)

            const { supportService } = await loadSupportService()
            await supportService.runOpenChat(admission, 7n, 'conn-1')

            expect(order).toEqual(['release'])
            expect(supportLlmServiceMock.openChatStream).not.toHaveBeenCalled()
        })

        it('never rejects, even when telling the client fails', async () => {
            broadcastServiceMock.broadcastMessageToUserConnection.mockImplementation(() => {
                throw new Error('socket gone')
            })
            broadcastServiceMock.broadcastMessageToUser.mockImplementation(() => {
                throw new Error('socket gone')
            })
            supportRepositoryMock.findChatHistory.mockRejectedValue(new Error('db down'))
            const admission = admissionOf()

            const { supportService } = await loadSupportService()

            await expect(
                supportService.runOpenChat(admission, 7n, 'conn-1'),
            ).resolves.toBeUndefined()
            expect(admission.release).toHaveBeenCalledTimes(1)
        })
    })
})
