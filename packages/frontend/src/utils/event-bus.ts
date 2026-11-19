import mitt from 'mitt'
import type { EventType } from 'mitt'
import type { BroadcastContracts } from 'shared/contracts'

// The events of the app. A broadcast event of the server (`broadcast:<event>`) comes out here
// under its own name with the payload of its contract (ADR 0006, decision 3): a new event in
// the registry is a new event of the bus, typed, with nothing to copy by hand.
export interface Events extends Record<EventType, unknown>, BroadcastContracts {
    init_app: undefined
    unauthorized: undefined
    update_available: undefined
    /**
     * The server registered the socket (`service:connection_ready`): events to the user reach it
     * from now on, and state they keep up to date is read again (feat-232).
     */
    ws_ready: undefined
}

const emitter = mitt<Events>()

export const useEventBus = () => emitter
