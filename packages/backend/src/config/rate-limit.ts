import { createEnvReader } from '#vendor/utils/env/env-reader.js'

export interface RateLimitSettings {
    windowMs: number
    /** 0 disables the limit. */
    max: number
}

const reader = createEnvReader()

const read = (prefix: string, defaults: RateLimitSettings): RateLimitSettings => ({
    windowMs: reader.int(`${prefix}_WINDOW_MS`, defaults.windowMs, { min: 1 }),
    max: reader.int(`${prefix}_MAX`, defaults.max, { min: 0 }),
})

const rateLimitConfig = Object.freeze({
    /** L1: every API request from one IP (fixed window). */
    httpGlobal: read('HTTP_GLOBAL_RATE_LIMIT', { windowMs: 60_000, max: 600 }),
    /**
     * WebSocket upgrade level 1: per-process flood filter before any I/O
     * (sliding log). The cluster-wide budget is wsUpgradeShared in throttle-policies.
     */
    wsUpgrade: read('WS_UPGRADE_RATE_LIMIT', { windowMs: 60_000, max: 120 }),
    /** Command timeout of the dedicated Redis connection for shared limits. */
    redisTimeoutMs: reader.int('RATE_LIMIT_REDIS_TIMEOUT_MS', 50, { min: 1 }),
    configError: reader.error,
})

export default rateLimitConfig
