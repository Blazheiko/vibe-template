// feat-201 (security review 2026-11-12, M-3): how many bytes of request bodies the process is
// buffering right now, in total and per client address. A body is read into memory before the
// session, CSRF and auth middlewares run, and the rate limits count requests, not bytes: one
// address could open hundreds of requests, send almost all of each body and stop, and hold
// gigabytes. The budget is charged chunk by chunk as the bytes arrive and given back when the
// body is complete, the client goes away or the read fails.
//
// In memory, per process. 0 switches a limit off.

export interface BodyBudgetLimits {
    /** Bytes of all bodies being read at once. */
    maxInFlightBodyBytes: number
    /** Bytes of the bodies one client address is sending at once. */
    maxInFlightBodyBytesPerIp: number
}

export type BodyBudgetAdmission = 'ok' | 'global' | 'ip'

let total = 0
const byIp = new Map<string, number>()

/**
 * Charges `bytes` to the address, or refuses and charges nothing. Synchronous: the check and
 * the charge are one step.
 */
export const chargeBodyBytes = (
    ipKey: string,
    bytes: number,
    limits: BodyBudgetLimits,
): BodyBudgetAdmission => {
    const { maxInFlightBodyBytes, maxInFlightBodyBytesPerIp } = limits
    const ofIp = byIp.get(ipKey) ?? 0
    if (maxInFlightBodyBytesPerIp > 0 && ofIp + bytes > maxInFlightBodyBytesPerIp) return 'ip'
    if (maxInFlightBodyBytes > 0 && total + bytes > maxInFlightBodyBytes) return 'global'
    total += bytes
    byIp.set(ipKey, ofIp + bytes)
    return 'ok'
}

/** Gives back what a request charged. */
export const releaseBodyBytes = (ipKey: string, bytes: number): void => {
    if (bytes <= 0) return
    total = Math.max(0, total - bytes)
    const left = (byIp.get(ipKey) ?? 0) - bytes
    if (left > 0) byIp.set(ipKey, left)
    else byIp.delete(ipKey)
}

export const bodyBytesInFlight = (ipKey?: string): number =>
    ipKey === undefined ? total : (byIp.get(ipKey) ?? 0)

/** Test hook: the counters are module state. */
export const __resetBodyBudgetForTests = (): void => {
    total = 0
    byIp.clear()
}
