import { pino, destination, multistream, stdSerializers } from 'pino'

import { sentryService } from '#app/services/observability/sentry-service.js'
import appConfig from '#config/app.js'
import loggingConfig from '#config/logging.js'
import { toSafeError } from '#vendor/utils/errors/scrub-error.js'

type BackendLogger = ReturnType<typeof pino>

interface LogEntry {
    level?: number
    msg?: string
    err?: unknown
    error?: unknown
    sentrySkip?: boolean
    sentryCapture?: boolean
    requestId?: string
    // Pino serializes bigint before this transport sees the entry, so userId arrives as string|number.
    userId?: string | number
    route?: string
    method?: string
}

interface SentryLogContext {
    requestId?: string
    userId?: string
    route?: string
    method?: string
}

const ERROR_LEVEL = 50

// Errors are logged through a scrubbed copy: a failed query must not put its params (password
// hashes, session tokens, emails) into stdout or, through sentryStream, into Sentry.
const serializeError = (value: unknown): unknown =>
    value instanceof Error ? stdSerializers.err(toSafeError(value)) : value
const isProduction = appConfig.env === 'prod' || appConfig.env === 'production'
const buildPretty = isProduction ? null : (await import('pino-pretty')).build

function buildSentryContext(entry: LogEntry): SentryLogContext {
    const context: SentryLogContext = {}

    if (typeof entry.requestId === 'string' && entry.requestId !== '') {
        context.requestId = entry.requestId
    }

    if (typeof entry.userId === 'string' || typeof entry.userId === 'number') {
        context.userId = String(entry.userId)
    }

    if (typeof entry.route === 'string' && entry.route !== '') {
        context.route = entry.route
    }

    if (typeof entry.method === 'string' && entry.method !== '') {
        context.method = entry.method
    }

    return context
}

// One Sentry event per Redis incident comes from database/redis-health.ts; the
// per-request logs of the same incident (pino writes the class name to err.type)
// stay in stdout only.
function isRedisUnavailableEntry(entry: LogEntry): boolean {
    const err = entry.err
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { type?: unknown }).type === 'RedisUnavailableError'
    )
}

const sentryStream = {
    level: 'error',
    write(chunk: string): boolean {
        const line = chunk.trim()
        if (line === '') {
            return true
        }

        try {
            const entry = JSON.parse(line) as LogEntry
            if (typeof entry.level !== 'number' || entry.level < ERROR_LEVEL) {
                return true
            }

            if (entry.sentrySkip === true || isRedisUnavailableEntry(entry)) {
                return true
            }

            const context = buildSentryContext(entry)
            if (entry.err !== undefined) {
                sentryService.captureException(entry.err, context)
                return true
            }

            if (entry.error !== undefined) {
                sentryService.captureException(entry.error, context)
                return true
            }

            if (entry.sentryCapture !== true) {
                return true
            }

            const message = typeof entry.msg === 'string' ? entry.msg : ''
            sentryService.captureMessage(message, 'error', context)
        } catch {
            return true
        }

        return true
    },
}

export const __loggerTestHooks = {
    sentryStream,
} as const

function createLogger(): BackendLogger {
    try {
        const baseConfig = {
            level: loggingConfig.level,
            serializers: {
                bigint: (value: bigint): string => value.toString(),
                err: serializeError,
                error: serializeError,
            },
        }

        const mainStream =
            buildPretty === null
                ? destination({ sync: false })
                : buildPretty({
                      colorize: true,
                  })

        return pino(
            baseConfig,
            multistream([
                { level: 'trace', stream: mainStream },
                { level: 'error', stream: sentryStream },
            ]),
        )
    } catch (error) {
        console.error('CRITICAL ERROR: Failed to initialize logger:', error)
        console.error('Application cannot continue without proper logging.')
        console.error('Please check your pino configuration and dependencies.')
        console.error('Exiting application...')

        // Принудительно завершаем процесс
        process.exit(1)
    }
}

export default createLogger()
