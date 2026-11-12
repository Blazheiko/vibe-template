import type { BroadcastEventName } from 'shared/contracts'

import { useEventBus, type Events } from '@/utils/event-bus'
import { reportValidationFailure } from '@/utils/sentry-payload-summary'
import { broadcastGuards } from '@/utils/ws-payload-guards'
import type { WebsocketMessage } from '@/utils/websocket-types'

const isBroadcastEvent = (name: string): name is BroadcastEventName =>
    Object.prototype.hasOwnProperty.call(broadcastGuards, name)

/**
 * Hands a broadcast event of the server (`broadcast:<event>`) to the event bus under its name,
 * once its guard has accepted the payload (ADR 0006, decision 3). A payload the guard refuses
 * is reported and dropped; an event the contract does not name is ignored.
 */
export const useBroadcastHandler = () => {
    const eventBus = useEventBus()

    const emitChecked = (event: BroadcastEventName, payload: unknown): void => {
        // The guard of this very event: it is what makes `payload` that event's payload.
        const guard = broadcastGuards[event] as (value: unknown) => boolean
        if (!guard(payload)) {
            reportValidationFailure(event, 'payload_shape', payload)
            return
        }
        eventBus.emit(event, payload as Events[BroadcastEventName])
    }

    const handleBroadcast = (message: WebsocketMessage): void => {
        const event = message.event.replace(/^broadcast:/, '')
        if (isBroadcastEvent(event)) emitChecked(event, message.payload)
    }

    return { handleBroadcast }
}
