import { afterEach, describe, expect, it, vi } from 'vitest'

const { captureExceptionMock, captureMessageMock } = vi.hoisted(() => ({
    captureExceptionMock: vi.fn(),
    captureMessageMock: vi.fn(),
}))

vi.mock('#app/services/observability/sentry-service.js', () => ({
    sentryService: {
        init: vi.fn(),
        isEnabled: vi.fn(() => true),
        captureException: captureExceptionMock,
        captureMessage: captureMessageMock,
        withScope: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
        flush: vi.fn().mockResolvedValue(true),
    },
}))

const originalEnv = { ...process.env }

function restoreEnv(): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
            delete process.env[key]
        }
    }

    Object.assign(process.env, originalEnv)
}

async function loadLogger() {
    return import('./logger.js')
}

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    restoreEnv()
})

describe('logger sentry forwarding', () => {
    it('forwards error and fatal levels only', async () => {
        process.env['APP_ENV'] = 'prod'

        const { default: logger } = await loadLogger()

        logger.info({ requestId: 'r-1' }, 'info message')
        logger.warn({ requestId: 'r-1' }, 'warn message')
        logger.error({ requestId: 'r-1', userId: 7n, sentryCapture: true }, 'error message')
        logger.fatal({ requestId: 'r-1', userId: 7n, sentryCapture: true }, 'fatal message')

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(captureMessageMock).not.toHaveBeenCalledWith(
            'info message',
            expect.anything(),
            expect.anything(),
        )
        expect(captureMessageMock).not.toHaveBeenCalledWith(
            'warn message',
            expect.anything(),
            expect.anything(),
        )
        expect(captureMessageMock).toHaveBeenCalledWith(
            'error message',
            'error',
            expect.objectContaining({ requestId: 'r-1', userId: '7' }),
        )
        expect(captureMessageMock).toHaveBeenCalledWith(
            'fatal message',
            'error',
            expect.objectContaining({ requestId: 'r-1', userId: '7' }),
        )
    })

    it('does not forward bare error logs without a sentry marker', async () => {
        process.env['APP_ENV'] = 'prod'

        const { default: logger } = await loadLogger()

        logger.error({ requestId: 'r-1' }, 'business validation failed')

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(captureExceptionMock).not.toHaveBeenCalled()
        expect(captureMessageMock).not.toHaveBeenCalled()
    })

    it('forwards explicitly marked message-only entries through the sentry stream', async () => {
        process.env['APP_ENV'] = 'prod'

        const { __loggerTestHooks } = await import('./logger.js')

        __loggerTestHooks.sentryStream.write(
            JSON.stringify({
                level: 50,
                msg: 'streamed message',
                requestId: 'r-1',
                sentryCapture: true,
            }) + '\n',
        )

        expect(captureExceptionMock).not.toHaveBeenCalled()
        expect(captureMessageMock).toHaveBeenCalledWith(
            'streamed message',
            'error',
            expect.objectContaining({ requestId: 'r-1' }),
        )
    })

    it('skips entries explicitly marked to bypass sentry', async () => {
        process.env['APP_ENV'] = 'prod'

        const { default: logger } = await loadLogger()

        logger.error({ requestId: 'r-1', sentrySkip: true }, 'uncaught exception log')

        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(captureExceptionMock).not.toHaveBeenCalled()
        expect(captureMessageMock).not.toHaveBeenCalled()
    })

    describe('Redis unavailability', () => {
        const write = async (entry: object): Promise<void> => {
            const { __loggerTestHooks } = await import('./logger.js')
            __loggerTestHooks.sentryStream.write(JSON.stringify({ level: 50, ...entry }) + '\n')
        }

        it('skips per-request logs with err.type RedisUnavailableError', async () => {
            await write({
                msg: 'Redis unavailable',
                err: { type: 'RedisUnavailableError', message: 'Command timed out' },
            })
            expect(captureExceptionMock).not.toHaveBeenCalled()
            expect(captureMessageMock).not.toHaveBeenCalled()
        })

        // A raw ioredis error from the rate-limit client has type 'Error', so the type
        // filter misses it; reportAppError marks it with sentrySkip instead.
        it('skips a raw ioredis error marked with sentrySkip', async () => {
            await write({
                msg: 'Service temporarily unavailable. Try again later.',
                sentrySkip: true,
                err: { type: 'Error', message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' },
            })
            expect(captureExceptionMock).not.toHaveBeenCalled()
            expect(captureMessageMock).not.toHaveBeenCalled()
        })

        it('still captures other errors', async () => {
            await write({ msg: 'Handle Error', err: { type: 'Error', message: 'x' } })
            expect(captureExceptionMock).toHaveBeenCalledTimes(1)
        })

        it('passes the redis-health incident event (sentryCapture, no err)', async () => {
            await write({ msg: 'Redis unavailable', sentryCapture: true })
            expect(captureMessageMock).toHaveBeenCalledWith(
                'Redis unavailable',
                'error',
                expect.anything(),
            )
        })
    })
})

describe('logger error scrubbing', () => {
    type Logger = Awaited<ReturnType<typeof loadLogger>>['default']

    const SECRETS = ['secret-hash', 'tok-123', 'a@b.c']

    async function failedQuery(): Promise<Error> {
        const { DrizzleQueryError } = await import('drizzle-orm')
        const { default: pg } = await import('pg')
        const cause = new pg.DatabaseError('duplicate key value', 0, 'error')
        cause.code = '23505'
        cause.constraint = 'users_email_unique'
        cause.detail = 'Key (email)=(a@b.c) already exists.'
        return new DrizzleQueryError(
            'update "users" set "password" = $1, "session_token" = $2 where "email" = $3',
            ['secret-hash', 'tok-123', 'a@b.c'],
            cause,
        )
    }

    // Every record the logger writes, as the JSON line the streams get.
    async function captureLines(log: (logger: Logger) => void): Promise<string[]> {
        process.env['APP_ENV'] = 'prod'
        const { default: logger, __loggerTestHooks } = await loadLogger()
        const lines: string[] = []
        const stream = __loggerTestHooks.sentryStream
        const write = stream.write.bind(stream)
        vi.spyOn(stream, 'write').mockImplementation((chunk: string) => {
            lines.push(chunk)
            return write(chunk)
        })

        log(logger)
        await new Promise((resolve) => setTimeout(resolve, 0))
        return lines
    }

    const logAs: [string, (logger: Logger, err: Error) => void][] = [
        [
            'err',
            (logger, err) => {
                logger.error({ err }, 'x')
            },
        ],
        [
            'error',
            (logger, err) => {
                logger.error({ error: err }, 'x')
            },
        ],
        [
            'first argument',
            (logger, err) => {
                logger.error(err)
            },
        ],
    ]

    it.each(logAs)('keeps query params out of the whole record (%s)', async (_label, log) => {
        const err = await failedQuery()
        const wrapped = new Error('change password failed', { cause: err })

        const lines = await captureLines((logger) => {
            log(logger, wrapped)
        })

        expect(lines).toHaveLength(1)
        const line = lines[0] ?? ''
        for (const secret of SECRETS) {
            expect(line).not.toContain(secret)
        }
        expect(line).toContain('Failed query (params redacted)')
        expect(line).toContain('code=23505 constraint=users_email_unique')
        // The original is untouched: db-errors.ts still reads it.
        expect(err.message).toContain('secret-hash')
    })

    // feat-126: an error outside `err` / `error`.
    it('scrubs and serializes an error nested in the record, without touching it', async () => {
        const err = await failedQuery()
        const context = { attempt: 2, failure: err }

        const lines = await captureLines((logger) => {
            logger.error({ context }, 'x')
        })

        const line = lines[0] ?? ''
        for (const secret of SECRETS) expect(line).not.toContain(secret)
        expect(line).toContain('Failed query (params redacted)')
        expect(context.failure).toBe(err)
    })

    // feat-127: pino takes msg from the error when the call gives none, before any serializer.
    it.each([
        [
            'error alone',
            (logger: Logger, err: Error): void => {
                logger.error(err)
            },
        ],
        [
            '{ err } without a message',
            (logger: Logger, err: Error): void => {
                logger.error({ err })
            },
        ],
    ])('keeps query params out of msg (%s)', async (_label, log) => {
        const err = await failedQuery()

        const lines = await captureLines((logger) => {
            log(logger, err)
        })

        const record = JSON.parse(lines[0] ?? '{}') as { msg?: string }
        expect(record.msg).toBe('Failed query (params redacted)')
        for (const secret of SECRETS) expect(lines[0]).not.toContain(secret)
    })

    // feat-127 (N1): a plain object with a message is data, not an error.
    // feat-137 (sixth review L11): the edges of the scrubber.
    it('scrubs a query error inside a class instance of the record', async () => {
        const err = await failedQuery()
        class Job {
            constructor(public failure: Error) {}
        }
        const lines = await captureLines((logger) => {
            logger.error({ job: new Job(err), sentryCapture: true }, 'job failed')
        })
        for (const secret of SECRETS) expect(lines.join('')).not.toContain(secret)
    })

    it('scrubs an error in the bindings of a child logger', async () => {
        const err = await failedQuery()
        const lines = await captureLines((logger) => {
            logger.child({ lastError: err }).error({ sentryCapture: true }, 'child failed')
        })
        expect(lines).toHaveLength(1)
        for (const secret of SECRETS) expect(lines.join('')).not.toContain(secret)
    })

    it('scrubs an error given as a format argument', async () => {
        const err = await failedQuery()
        const lines = await captureLines((logger) => {
            logger.error({ sentryCapture: true }, 'failed: %s %o', err, { inner: err })
        })
        expect(lines).toHaveLength(1)
        for (const secret of SECRETS) expect(lines.join('')).not.toContain(secret)
    })

    it('keeps the fields of plain objects that have a message', async () => {
        const lines = await captureLines((logger) => {
            logger.error(
                {
                    response: { code: 'E_NOT_FOUND', message: 'User not found' },
                    payload: { message: 'hi', where: 'x' },
                },
                'x',
            )
        })

        const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
        expect(record['response']).toStrictEqual({ code: 'E_NOT_FOUND', message: 'User not found' })
        expect(record['payload']).toStrictEqual({ message: 'hi', where: 'x' })
    })

    it('hands Sentry the scrubbed error', async () => {
        const err = await failedQuery()

        await captureLines((logger) => {
            logger.error({ err }, 'x')
        })

        const sent = JSON.stringify(captureExceptionMock.mock.calls[0]?.[0])
        expect(sent).toContain('Failed query (params redacted)')
        for (const secret of SECRETS) {
            expect(sent).not.toContain(secret)
        }
    })

    it('keeps the class name pino writes to err.type', async () => {
        const { RedisUnavailableError } =
            await import('#vendor/utils/network/errors/redis-unavailable-error.js')
        const lines = await captureLines((logger) => {
            logger.error({ err: new RedisUnavailableError('down') }, 'x')
        })

        const record = JSON.parse(lines[0] ?? '{}') as { err?: { type?: string } }
        expect(record.err?.type).toBe('RedisUnavailableError')
    })
})
