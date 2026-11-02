import {
    RedisUnavailableError,
    isRedisCommandUnavailable,
} from '#vendor/utils/network/errors/redis-unavailable-error.js'

export type RedisHealthState = 'healthy' | 'unavailable'

interface HealthClient {
    readonly status: string
    on(event: 'error', listener: (err: unknown) => void): unknown
    on(event: 'close' | 'ready', listener: () => void): unknown
    ping(): Promise<unknown>
}

interface HealthLogger {
    error(obj: object, msg: string): void
    warn(obj: object, msg: string): void
    info(obj: object, msg: string): void
}

export interface RedisHealth {
    readonly state: RedisHealthState
    markUnavailable(err?: unknown): void
    markHealthy(): void
    /** Shutdown: stop the PING timer and ignore further client events. */
    stop(): void
}

export interface RedisHealthOptions {
    logger: HealthLogger
    pingIntervalMs?: number
    warnIntervalMs?: number
    now?: () => number
}

const reasonOf = (err: unknown): string | undefined =>
    err instanceof Error ? err.message : undefined

/**
 * Health of the main Redis client: one error-level log (one Sentry event) per
 * incident, a rate-limited warn while it lasts, and "Redis recovered" on the
 * first success, background PING or ready event, whichever comes first.
 */
export const createRedisHealth = (
    client: HealthClient,
    { logger, pingIntervalMs = 2_000, warnIntervalMs = 60_000, now = Date.now }: RedisHealthOptions,
): RedisHealth => {
    let state: RedisHealthState = 'healthy'
    let downSince = 0
    let lastWarn = 0
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let pingInFlight = false
    let stopped = false

    const stopPing = (): void => {
        if (pingTimer === null) return
        clearInterval(pingTimer)
        pingTimer = null
    }

    const ping = (): void => {
        if (pingInFlight) return
        pingInFlight = true
        client
            .ping()
            .then(markHealthy, (err: unknown) => {
                markUnavailable(err)
            })
            .finally(() => {
                pingInFlight = false
            })
    }

    function markUnavailable(err?: unknown): void {
        if (stopped) return
        const at = now()
        if (state === 'unavailable') {
            if (at - lastWarn < warnIntervalMs) return
            lastWarn = at
            logger.warn(
                { reason: reasonOf(err), downMs: at - downSince },
                'Redis still unavailable',
            )
            return
        }
        state = 'unavailable'
        downSince = at
        lastWarn = at
        // No `err` field: the Sentry transport would capture it as an exception
        // (or skip a RedisUnavailableError); this message is the incident event.
        logger.error({ sentryCapture: true, reason: reasonOf(err) }, 'Redis unavailable')
        pingTimer = setInterval(ping, pingIntervalMs)
        pingTimer.unref()
    }

    function markHealthy(): void {
        if (stopped || state === 'healthy') return
        state = 'healthy'
        stopPing()
        logger.info({ downMs: now() - downSince }, 'Redis recovered')
    }

    client.on('error', (err: unknown) => {
        markUnavailable(err)
    })
    client.on('close', () => {
        markUnavailable(new RedisUnavailableError('Connection is closed'))
    })
    client.on('ready', () => {
        markHealthy()
    })

    return {
        get state(): RedisHealthState {
            return state
        },
        markUnavailable,
        markHealthy,
        stop(): void {
            stopped = true
            stopPing()
        },
    }
}

/**
 * Runs one command of the main client. Not ready → RedisUnavailableError
 * without sending anything (no offline queue: nothing executes later behind the
 * caller's back). An unavailability error is wrapped in RedisUnavailableError;
 * any other error (a bug) is rethrown as is.
 */
export const createWithRedis =
    (client: Pick<HealthClient, 'status'>, health: RedisHealth) =>
    async <T>(op: () => Promise<T>): Promise<T> => {
        if (client.status !== 'ready') {
            const err = new RedisUnavailableError(`Redis connection is ${client.status}`)
            health.markUnavailable(err)
            throw err
        }
        try {
            const result = await op()
            health.markHealthy()
            return result
        } catch (err: unknown) {
            if (!isRedisCommandUnavailable(err)) throw err
            health.markUnavailable(err)
            throw err instanceof RedisUnavailableError
                ? err
                : new RedisUnavailableError('Redis command failed', { cause: err })
        }
    }
