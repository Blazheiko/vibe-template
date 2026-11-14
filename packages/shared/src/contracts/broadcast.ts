import type { BroadcastEventName, BroadcastPayload } from '../schemas/ws/broadcast-events.js'

/**
 * The events the server pushes on its own (`broadcast:<event>`) and their payloads, as types
 * only (ADR 0006, decision 3). The schemas stay in shared/schemas/ws/broadcast-events.ts: the
 * backend checks every event against them before sending; the frontend checks it with the
 * guards of utils/ws-payload-guards.ts, which have to cover every event of this map.
 */
export type BroadcastContracts = {
    readonly [E in BroadcastEventName]: BroadcastPayload<E>
}

export type { BroadcastEventName }
