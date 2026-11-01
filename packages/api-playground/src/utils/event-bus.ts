import mitt from 'mitt'
import type { EventType } from 'mitt'

export interface Events extends Record<EventType, unknown> {
    broadcast: unknown
    unauthorized: undefined
}

const emitter = mitt<Events>()

export const useEventBus = () => emitter
