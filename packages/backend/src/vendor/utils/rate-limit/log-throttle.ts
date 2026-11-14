/**
 * feat-206: at most one log line per key and window. `shouldLog` answers `null` while the
 * line of this key is still fresh, otherwise the number of lines left out since the last
 * one. The table is bounded: when it is full of fresh keys, new keys are not logged at all,
 * which is the point when someone sends a flood from many addresses.
 */
const DEFAULT_MAX_KEYS = 10_000

interface Entry {
    until: number
    suppressed: number
}

export interface LogThrottle {
    shouldLog: (key: string, windowMs: number, now?: number) => number | null
    size: () => number
}

export const createLogThrottle = (maxKeys = DEFAULT_MAX_KEYS): LogThrottle => {
    const entries = new Map<string, Entry>()

    const dropExpired = (now: number): void => {
        for (const [key, entry] of entries) {
            if (entry.until <= now) entries.delete(key)
        }
    }

    return {
        shouldLog(key, windowMs, now = Date.now()): number | null {
            const entry = entries.get(key)
            if (entry !== undefined) {
                if (entry.until > now) {
                    entry.suppressed += 1
                    return null
                }
                const { suppressed } = entry
                entry.until = now + windowMs
                entry.suppressed = 0
                return suppressed
            }
            if (entries.size >= maxKeys) {
                dropExpired(now)
                if (entries.size >= maxKeys) return null
            }
            entries.set(key, { until: now + windowMs, suppressed: 0 })
            return 0
        },
        size: () => entries.size,
    }
}
