import type { WsBroadcastEnvelope } from 'shared/ws-client'

export const makeBroadcastJson = (event: string, status: number, payload: unknown): string => {
    const envelope: WsBroadcastEnvelope = { event: `broadcast:${event}`, status, payload }
    return makeJson(envelope)
}

export const makeJson = (value: unknown): string =>
    JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
