import { type, type Type } from '@arktype/type'

import { defaultValidator } from '#app/validate/index.js'
import type { WsMessage } from '#vendor/types/types.js'

const WsMessageSchema = type({
    payload: 'Record<string, unknown> | null',
    event: 'string',
    // The request id the reply echoes (ADR 0006): the client's, opaque to the server.
    'id?': '0 < string <= 64',
    timestamp: 'number',
    // ArkType validates this expression correctly, but its inferred TS payload type
    // does not line up with WsMessage without an explicit bridge.
}) as unknown as Type<WsMessage>

export const wsMessageValidator = defaultValidator(WsMessageSchema)
