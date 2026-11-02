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
