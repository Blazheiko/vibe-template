import type { AnyContract, BodyOf, KindOf, ResponseOf } from 'shared/contracts'
import type { WsReplyEnvelope } from 'shared/ws-client'

import { useWebSocketConnection } from '@/composables/useWebSocketConnection'

// The typed way to send a request over the WebSocket (docs/adr/0006-websocket-contracts.md). A
// WS contract from `shared/contracts` names the event and the types of the payload and the
// reply; `callWs` sends it through the connection, which waits for the reply under the
// request's id. It settles as the connection does: it resolves with the reply, a business
// error included (`data.status === 'error'`), and rejects on a transport error or a timeout.

/** A reply to a WS request: the shared envelope, with `data` typed by the contract. */
export type WsReply<TResponse> = WsReplyEnvelope<TResponse>

type PayloadArgs<C> = [BodyOf<C>] extends [undefined] ? [payload?: undefined] : [payload: BodyOf<C>]

/**
 * Sends the request of a WS contract.
 *
 *     await callWs(supportWsContracts.chat, { message, language, clientMessageId })
 *     await callWs(adminWsContracts.subscribeOnlineUsers)
 */
export const callWs = async <C extends AnyContract>(
    contract: C & (KindOf<C> extends 'ws' ? unknown : { readonly kind: 'ws' }),
    ...[payload]: PayloadArgs<C>
): Promise<WsReply<ResponseOf<C>>> => {
    const { websocketApi } = useWebSocketConnection()
    const reply = await websocketApi(
        // The event under the prefix: `/support/support_chat` → `api/support/support_chat`.
        contract.path.replace(/^\/+/, ''),
        payload ?? {},
    )
    // The reply of this contract's event: its `data` is the contract's response (ADR 0006).
    return reply as WsReply<ResponseOf<C>>
}
