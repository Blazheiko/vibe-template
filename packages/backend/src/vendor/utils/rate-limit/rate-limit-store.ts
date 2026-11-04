import logger from '#vendor/utils/logger.js'
import { rateLimitKeyForIp } from '../network/ip-address.js'

// In-memory, per-process, synchronous rate-limit store.
//
// Sync by design: the HTTP check runs before res.onData() is registered, and an
// `await` there loses the body of small POST requests in uWebSockets.js. Each
// instance keeps its own counters, so with N instances the effective limit is N×.
//
// Rejected attempts do not consume quota and are not stored: the state per key
// stays bounded and `retryAfterMs` is the exact time a slot frees up.

export type RateLimitAlgorithm = 'sliding-log' | 'fixed-window'

export interface ConsumeOptions {
    windowMs: number
    /** 0 disables the limit. */
    max: number
    algorithm?: RateLimitAlgorithm
}

export type RateLimitDecision =
    | { allowed: true; limit: number; remaining: number; resetAt: number }
    | { allowed: false; limit: number; retryAfterMs: number; resetAt: number }

type Bucket =
    | { kind: 'sliding-log'; windowMs: number; timestamps: number[] }
    | {
          kind: 'fixed-window'
          windowMs: number
          windowStart: number
          count: number
      }

export interface RateLimitStoreOptions {
    /** Hard cap on the number of keys. */
    maxKeys?: number
    /** How many keys from the oldest end are checked for expiry before evicting. */
    evictScan?: number
    now?: () => number
}

export interface RateLimitStore {
    consume(key: string, options: ConsumeOptions): RateLimitDecision
    /** Full sweep of expired keys; runs from a timer, never on the hot path. */
    gc(): number
    readonly size: number
    /** Keys inspected by the last insert of a new key (for tests). */
    readonly lastInsertScan: number
    readonly evictions: number
}

const DEFAULT_MAX_KEYS = 100_000
const DEFAULT_EVICT_SCAN = 64
const EVICTION_LOG_INTERVAL_MS = 60_000

const isExpired = (bucket: Bucket, now: number): boolean => {
    if (bucket.kind === 'fixed-window') {
        return bucket.windowStart + bucket.windowMs <= now
    }
    const last = bucket.timestamps[bucket.timestamps.length - 1]
    return last === undefined || last + bucket.windowMs <= now
}

export function createRateLimitStore(options: RateLimitStoreOptions = {}): RateLimitStore {
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
    const evictScan = options.evictScan ?? DEFAULT_EVICT_SCAN
    const now = options.now ?? Date.now
    // Map keeps insertion order: the head holds the oldest keys.
    const buckets = new Map<string, Bucket>()
    let lastInsertScan = 0
    let evictions = 0
    let lastEvictionLog = Number.NEGATIVE_INFINITY

    const makeRoom = (time: number): void => {
        lastInsertScan = 0
        if (buckets.size < maxKeys) return

        const expired: string[] = []
        for (const [key, bucket] of buckets) {
            if (lastInsertScan >= evictScan) break
            lastInsertScan++
            if (isExpired(bucket, time)) expired.push(key)
        }
        for (const key of expired) buckets.delete(key)

        // Still full: drop the oldest key. Quotas are not strict while the store overflows.
        while (buckets.size >= maxKeys) {
            const oldest = buckets.keys().next()
            if (oldest.done === true) break
            buckets.delete(oldest.value)
            evictions++
            if (time - lastEvictionLog >= EVICTION_LOG_INTERVAL_MS) {
                lastEvictionLog = time
                logger.warn(
                    { maxKeys, evictions },
                    'Rate-limit store is full, evicting the oldest keys',
                )
            }
        }
    }

    const getBucket = (
        key: string,
        algorithm: RateLimitAlgorithm,
        windowMs: number,
        time: number,
    ): Bucket => {
        const existing = buckets.get(key)
        if (existing?.kind === algorithm) {
            existing.windowMs = windowMs
            return existing
        }
        if (existing === undefined) makeRoom(time)
        const bucket: Bucket =
            algorithm === 'fixed-window'
                ? { kind: algorithm, windowMs, windowStart: time, count: 0 }
                : { kind: algorithm, windowMs, timestamps: [] }
        buckets.set(key, bucket)
        return bucket
    }

    const consume = (key: string, opts: ConsumeOptions): RateLimitDecision => {
        const { windowMs, max } = opts
        const time = now()
        if (max <= 0) {
            return { allowed: true, limit: 0, remaining: 0, resetAt: time }
        }

        const bucket = getBucket(key, opts.algorithm ?? 'sliding-log', windowMs, time)

        if (bucket.kind === 'fixed-window') {
            if (bucket.windowStart + windowMs <= time) {
                bucket.windowStart = time
                bucket.count = 0
            }
            const resetAt = bucket.windowStart + windowMs
            if (bucket.count < max) {
                bucket.count++
                return {
                    allowed: true,
                    limit: max,
                    remaining: max - bucket.count,
                    resetAt,
                }
            }
            return {
                allowed: false,
                limit: max,
                retryAfterMs: resetAt - time,
                resetAt,
            }
        }

        const log = bucket.timestamps
        let drop = 0
        while (drop < log.length) {
            const ts = log[drop]
            if (ts === undefined || ts + windowMs > time) break
            drop++
        }
        if (drop > 0) log.splice(0, drop)

        if (log.length < max) {
            log.push(time)
            return {
                allowed: true,
                limit: max,
                remaining: max - log.length,
                resetAt: (log[0] ?? time) + windowMs,
            }
        }

        // The slot frees up when the entry that keeps the log at `max` leaves the window.
        const blocking = log[log.length - max] ?? time
        const resetAt = blocking + windowMs
        return {
            allowed: false,
            limit: max,
            retryAfterMs: resetAt - time,
            resetAt,
        }
    }

    const gc = (): number => {
        const time = now()
        let removed = 0
        for (const [key, bucket] of buckets) {
            if (isExpired(bucket, time)) {
                buckets.delete(key)
                removed++
            }
        }
        return removed
    }

    return {
        consume,
        gc,
        get size(): number {
            return buckets.size
        },
        get lastInsertScan(): number {
            return lastInsertScan
        },
        get evictions(): number {
            return evictions
        },
    }
}

/** Seconds for the Retry-After header: never 0, so clients do not retry at once. */
export const retryAfterSeconds = (retryAfterMs: number): number =>
    Math.max(1, Math.ceil(retryAfterMs / 1000))

/** The client's budget key: IPv6 grouped by /64, see rateLimitKeyForIp (feat-110). */
export const clientKey = (ip: string | null | undefined): string => rateLimitKeyForIp(ip)

/** The process-wide store shared by the HTTP, upgrade and WS message limiters. */
export const rateLimitStore = createRateLimitStore()

setInterval(() => {
    const removed = rateLimitStore.gc()
    if (removed > 0) {
        logger.debug({ removed, remaining: rateLimitStore.size }, 'rate-limit GC')
    }
}, 60_000).unref()
