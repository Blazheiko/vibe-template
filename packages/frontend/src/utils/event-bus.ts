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
    /**
     * feat-240 (Р8): the admin channel was joined again after a pause; the online list missed the
     * events meanwhile and is read again.
     */
    admin_online_reload: undefined
    /**
     * feat-245 (Р15): an action needs a new sign-in (`sign_in_again_required`,
     * `mfa_session_required`); the payload is the page to come back to.
     */
    sign_in_again: string
}

const emitter = mitt<Events>()

export const useEventBus = () => emitter
