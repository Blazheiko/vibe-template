import { afterEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../shared/errors.js'

const {
    initMock,
    captureExceptionMock,
    captureMessageMock,
    flushMock,
    scopeMock,
    addEventProcessorMock,
    withScopeMock,
} = vi.hoisted(() => {
    const scope = {
        setTag: vi.fn(),
        setUser: vi.fn(),
        setExtra: vi.fn(),
    }

    return {
        initMock: vi.fn(),
        captureExceptionMock: vi.fn(),
        captureMessageMock: vi.fn(),
        flushMock: vi.fn().mockResolvedValue(true),
        addEventProcessorMock: vi.fn(),
        scopeMock: scope,
        withScopeMock: vi.fn(
            (
                callback: (scope: {
                    setTag: (key: string, value: string) => void
                    setUser: (value: { id: string }) => void
                    setExtra: (key: string, value: unknown) => void
                }) => void,
            ) => {
                callback(scope)
            },
        ),
    }
})

const originalEnv = { ...process.env }

vi.mock('@sentry/node', () => ({
    init: initMock,
    addEventProcessor: addEventProcessorMock,
    captureException: captureExceptionMock,
    captureMessage: captureMessageMock,
    flush: flushMock,
    withScope: withScopeMock,
}))

function restoreEnv(): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
            delete process.env[key]
        }
    }

    Object.assign(process.env, originalEnv)
}

async function loadSentryService() {
    return import('./sentry-service.js')
}

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    restoreEnv()
})

describe('sentryService', () => {
    it('stays disabled when DSN is unset', async () => {
        delete process.env['SENTRY_DSN']
        process.env['SENTRY_ENABLED'] = 'true'

        const { sentryService } = await loadSentryService()
        sentryService.init()

        expect(sentryService.isEnabled()).toBe(false)
        expect(initMock).not.toHaveBeenCalled()

        sentryService.captureException(new Error('boom'))
        sentryService.captureMessage('boom')
        expect(captureExceptionMock).not.toHaveBeenCalled()
        expect(captureMessageMock).not.toHaveBeenCalled()
        await expect(sentryService.flush()).resolves.toBe(true)
    })

    it('stays disabled when the kill switch is off', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'false'

        const { sentryService } = await loadSentryService()
        sentryService.init()

        expect(sentryService.isEnabled()).toBe(false)
        expect(initMock).not.toHaveBeenCalled()

        sentryService.captureException(new Error('boom'))
        sentryService.captureMessage('boom')
        await expect(sentryService.flush()).resolves.toBe(true)
        expect(captureExceptionMock).not.toHaveBeenCalled()
        expect(captureMessageMock).not.toHaveBeenCalled()
    })

    it('maps context onto Sentry scope', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'
        process.env['SENTRY_ENVIRONMENT'] = 'prod'
        process.env['SENTRY_RELEASE'] = 'abc123'
        process.env['SENTRY_TRACES_SAMPLE_RATE'] = '0.25'

        const { sentryService } = await loadSentryService()
        sentryService.init()

        const error = new Error('request failed')
        sentryService.captureException(error, {
            requestId: 'r-1',
            userId: '42',
            route: '/api/x',
            method: 'POST',
            tags: { custom: 'value' },
            extra: { articleId: 7 },
        })

        expect(initMock).toHaveBeenCalledTimes(1)
        expect(addEventProcessorMock).toHaveBeenCalledTimes(1)
        expect(withScopeMock).toHaveBeenCalledTimes(1)
        expect(scopeMock.setTag).toHaveBeenCalledWith('custom', 'value')
        expect(scopeMock.setTag).toHaveBeenCalledWith('requestId', 'r-1')
        expect(scopeMock.setTag).toHaveBeenCalledWith('route', '/api/x')
        expect(scopeMock.setTag).toHaveBeenCalledWith('method', 'POST')
        expect(scopeMock.setUser).toHaveBeenCalledWith({ id: '42' })
        expect(scopeMock.setExtra).toHaveBeenCalledWith('articleId', 7)
        // A scrubbed copy, not the error itself (feat-102).
        const captured = captureExceptionMock.mock.calls[0]?.[0] as Error
        expect(captured).toBeInstanceOf(Error)
        expect(captured).not.toBe(error)
        expect(captured.message).toBe('request failed')
        expect(captured.stack).toBe(error.stack)
    })

    it('disables personal and payload data collection (Sentry 11 defaults collect it)', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'

        const { sentryService } = await loadSentryService()
        sentryService.init()

        expect(initMock).toHaveBeenCalledWith(
            expect.objectContaining({
                dataCollection: expect.objectContaining({
                    userInfo: false,
                    cookies: false,
                    httpBodies: [],
                    genAI: { inputs: false, outputs: false },
                    databaseQueryData: false,
                }),
            }),
        )
    })

    it('flushes after init', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'

        const { sentryService } = await loadSentryService()
        sentryService.init()

        await expect(sentryService.flush(1234)).resolves.toBe(true)
        expect(flushMock).toHaveBeenCalledWith(1234)
    })

    it('scrubs event processor payloads', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'

        const { sentryService } = await loadSentryService()
        sentryService.init()

        const eventProcessor = addEventProcessorMock.mock.calls[0]?.[0] as
            ((event: Record<string, unknown>) => Record<string, unknown> | null) | undefined
        if (eventProcessor === undefined) {
            throw new Error('event processor was not configured')
        }

        const event = {
            tags: {
                apiToken: 'abc',
                safe: 'ok',
            },
            extra: {
                password: 'secret',
                keep: 'value',
            },
            contexts: {
                sessionCookie: 'cookie',
                keep: { foo: 'bar' },
            },
            request: {
                status_code: 500,
                headers: {
                    authorization: 'Bearer token',
                    cookie: 'session=abc',
                    'x-request-id': 'r-1',
                },
                data: 'x'.repeat(50 * 1024),
            },
        }

        const sanitized = eventProcessor(event)
        expect(sanitized).not.toBeNull()
        const sanitizedEvent = sanitized as {
            tags?: Record<string, unknown>
            extra?: Record<string, unknown>
            contexts?: Record<string, unknown>
            request?: Record<string, unknown>
        }
        expect(sanitizedEvent.tags).toEqual({ safe: 'ok' })
        expect(sanitizedEvent.extra).toEqual({ keep: 'value' })
        expect(sanitizedEvent.contexts).toEqual({ keep: { foo: 'bar' } })
        expect(sanitizedEvent.request?.['headers']).toEqual({
            'x-request-id': 'r-1',
        })
        expect(sanitizedEvent.request?.['data']).toBeUndefined()
    })

    // feat-126: the extra and contexts objects belong to the caller; scrubbing works on a copy.
    it('scrubs the event without changing the objects the caller passed', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'
        const { sentryService } = await loadSentryService()
        sentryService.init()
        const eventProcessor = addEventProcessorMock.mock.calls[0]?.[0] as
            ((event: Record<string, unknown>) => Record<string, unknown> | null) | undefined
        if (eventProcessor === undefined) throw new Error('event processor was not configured')

        const callerExtra = { password: 'secret', nested: { apiToken: 'abc', keep: 1 } }
        const callerContext = { sessionCookie: 'cookie', keep: true }

        const sanitized = eventProcessor({
            extra: callerExtra,
            contexts: { app: callerContext },
        }) as { extra?: unknown; contexts?: { app?: unknown } }

        expect(sanitized.extra).toEqual({ nested: { keep: 1 } })
        expect(sanitized.contexts?.app).toEqual({ keep: true })
        // The caller's objects still hold what they held.
        expect(callerExtra).toEqual({ password: 'secret', nested: { apiToken: 'abc', keep: 1 } })
        expect(callerContext).toEqual({ sessionCookie: 'cookie', keep: true })
    })

    // feat-127 (N2): Sentry normalizes a class instance into its own fields after the processor.
    it('drops sensitive fields of a class instance and keeps dates as they are', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'
        const { sentryService } = await loadSentryService()
        sentryService.init()
        const eventProcessor = addEventProcessorMock.mock.calls[0]?.[0] as
            ((event: Record<string, unknown>) => Record<string, unknown> | null) | undefined
        if (eventProcessor === undefined) throw new Error('event processor was not configured')

        class Credentials {
            constructor(
                public login: string,
                public password: string,
                public inner: { accessToken: string; keep: number },
            ) {}
        }
        const at = new Date(0)
        const instance = new Credentials('bob', 'hunter2', { accessToken: 'tok', keep: 1 })

        const sanitized = eventProcessor({
            extra: { instance, at },
            contexts: { app: { instance } },
        }) as { extra?: Record<string, unknown>; contexts?: { app?: Record<string, unknown> } }

        expect(sanitized.extra?.['instance']).toEqual({ login: 'bob', inner: { keep: 1 } })
        expect(sanitized.contexts?.app?.['instance']).toEqual({ login: 'bob', inner: { keep: 1 } })
        expect(sanitized.extra?.['at']).toBe(at)
        expect(instance.password).toBe('hunter2')
    })

    // feat-137 (sixth review L10, L11): a class with toJSON and no own fields (URL, Decimal) became
    // `{}`; an Error's own sensitive fields stayed.
    it("sends a toJSON value as what toJSON returns, and drops an error's sensitive own fields", async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'
        const { sentryService } = await loadSentryService()
        sentryService.init()
        const eventProcessor = addEventProcessorMock.mock.calls[0]?.[0] as
            ((event: Record<string, unknown>) => Record<string, unknown> | null) | undefined
        if (eventProcessor === undefined) throw new Error('event processor was not configured')

        class Decimal {
            readonly #value: string
            constructor(value: string) {
                this.#value = value
            }
            toJSON(): string {
                return this.#value
            }
        }
        const failure = Object.assign(new Error('boom'), { password: 'hunter2', step: 'save' })

        const sanitized = eventProcessor({
            extra: {
                url: new URL('https://app.test/path?x=1'),
                amount: new Decimal('12.50'),
                failure,
            },
        }) as { extra?: Record<string, unknown> }

        expect(sanitized.extra?.['url']).toBe('https://app.test/path?x=%5BFiltered%5D')
        expect(sanitized.extra?.['amount']).toBe('12.50')
        const safe = sanitized.extra?.['failure'] as Record<string, unknown>
        expect(safe['password']).toBeUndefined()
        expect(safe['step']).toBe('save')
        expect(failure.password).toBe('hunter2')
    })

    // feat-139 (seventh review Q2, Q3): a URL keeps no secret of its query, fragment or userinfo;
    // a value past the depth limit is cut, not sent as it is.
    it('redacts a URL and cuts a value past the depth limit', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'
        const { sentryService } = await loadSentryService()
        sentryService.init()
        const eventProcessor = addEventProcessorMock.mock.calls[0]?.[0] as
            ((event: Record<string, unknown>) => Record<string, unknown> | null) | undefined
        if (eventProcessor === undefined) throw new Error('event processor was not configured')

        class SelfRef {
            password = 'PWSELF'
            toJSON(): unknown {
                return this
            }
        }
        let deep: Record<string, unknown> = { password: 'PWDEEP', token: 'TKDEEP' }
        for (let i = 0; i < 20; i++) deep = { next: deep }

        const sanitized = eventProcessor({
            extra: {
                link: new URL(
                    'https://u:pw@app.test/reset?token=RESETSECRET&code=OAUTHCODE#frag=HASH',
                ),
                self: new SelfRef(),
                deep,
            },
        })
        const sent = JSON.stringify(sanitized)
        for (const secret of [
            'RESETSECRET',
            'OAUTHCODE',
            'HASH',
            'pw@',
            'PWSELF',
            'PWDEEP',
            'TKDEEP',
        ]) {
            expect(sent).not.toContain(secret)
        }
        const extra = (sanitized as { extra: Record<string, unknown> }).extra
        expect(extra['link']).toBe(
            'https://%5BFiltered%5D:%5BFiltered%5D@app.test/reset?token=%5BFiltered%5D&code=%5BFiltered%5D#[Filtered]',
        )
        expect(extra['self']).toEqual({})
        expect(sent).toContain('[Truncated]')
    })

    it('normalizes internal app errors before capturing them', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'

        const { sentryService } = await loadSentryService()
        sentryService.init()

        const cause = new Error('db down')
        sentryService.captureException(internal(cause, 'Failed to load profile'))

        expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        const captured = captureExceptionMock.mock.calls[0]?.[0] as Error & {
            cause?: unknown
        }
        expect(captured).toBeInstanceOf(Error)
        expect(captured.message).toBe('Failed to load profile')
        expect(captured.name).toBe('AppError.Internal')
        expect(captured.cause).toBeInstanceOf(Error)
        expect((captured.cause as Error).message).toBe('db down')
    })

    it('truncates request data when status_code is missing', async () => {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'

        const { sentryService } = await loadSentryService()
        sentryService.init()

        const eventProcessor = addEventProcessorMock.mock.calls[0]?.[0] as
            ((event: Record<string, unknown>) => Record<string, unknown> | null) | undefined
        if (eventProcessor === undefined) {
            throw new Error('event processor was not configured')
        }

        const sanitized = eventProcessor({
            request: {
                data: 'x'.repeat(50 * 1024),
            },
        })

        expect(sanitized).not.toBeNull()
        const request = (sanitized as { request?: Record<string, unknown> }).request
        expect(request?.['data']).toHaveLength(10 * 1024)
    })
})

describe('sentryService query-error scrubbing', () => {
    const SECRETS = ['secret-hash', 'tok-123', 'a@b.c']

    async function failedQuery(): Promise<Error> {
        const { DrizzleQueryError } = await import('drizzle-orm')
        const { default: pg } = await import('pg')
        const cause = new pg.DatabaseError('duplicate key value', 0, 'error')
        cause.code = '23505'
        cause.detail = 'Key (email)=(a@b.c) already exists.'
        return new DrizzleQueryError(
            'update "users" set "password" = $1, "session_token" = $2 where "email" = $3',
            ['secret-hash', 'tok-123', 'a@b.c'],
            cause,
        )
    }

    function expectNoSecrets(value: unknown): void {
        const text = JSON.stringify(value, (_key, inner: unknown) =>
            inner instanceof Error
                ? Object.assign(
                      { message: inner.message, stack: inner.stack, cause: inner.cause },
                      inner,
                  )
                : inner,
        )
        for (const secret of SECRETS) {
            expect(text).not.toContain(secret)
        }
    }

    async function initService() {
        process.env['SENTRY_DSN'] = 'https://example.com/1'
        process.env['SENTRY_ENABLED'] = 'true'
        const { sentryService } = await loadSentryService()
        sentryService.init()
        const processor = addEventProcessorMock.mock.calls[0]?.[0] as
            ((event: Record<string, unknown>, hint: Record<string, unknown>) => unknown) | undefined
        if (processor === undefined) throw new Error('event processor was not configured')
        return { sentryService, processor }
    }

    it('captures a scrubbed copy of the error and of an Internal app error cause', async () => {
        const { sentryService } = await initService()
        const err = await failedQuery()

        sentryService.captureException(err)
        sentryService.captureException(internal(err, 'change password failed'))

        expect(captureExceptionMock).toHaveBeenCalledTimes(2)
        for (const [captured] of captureExceptionMock.mock.calls) {
            expectNoSecrets(captured)
        }
        expect((captureExceptionMock.mock.calls[0]?.[0] as Error).message).toBe(
            'Failed query (params redacted)',
        )
        expect(err.message).toContain('secret-hash')
    })

    it('scrubs exception values Sentry built from an uncaught original error', async () => {
        const { processor } = await initService()
        const err = await failedQuery()
        const event = {
            exception: {
                values: [
                    { type: 'error', value: (err.cause as Error).message },
                    { type: 'DrizzleQueryError', value: err.message },
                    { type: 'Error', value: `wrapped: ${err.message}` },
                ],
            },
            message: `log: ${err.message}`,
            extra: { a: [{ b: { password: 'secret-hash', keep: 1 } }], text: err.message },
            contexts: { db: { query: 'select $1', params: ['tok-123'], kept: 'yes' } },
            breadcrumbs: [{ message: err.message, data: { nested: { token: 'tok-123' } } }],
        }

        const sanitized = processor(event, { originalException: err }) as typeof event

        expectNoSecrets(sanitized)
        expect(sanitized.exception.values[0]?.value).toBe('Database error (code=23505)')
        expect(sanitized.exception.values[1]?.value).toBe('Failed query (params redacted)')
        expect(sanitized.extra.a[0]?.b).toEqual({ keep: 1 })
        expect(sanitized.contexts.db).toEqual({ kept: 'yes' })
    })
})
