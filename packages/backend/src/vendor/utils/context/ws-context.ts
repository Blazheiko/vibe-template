import type {
    Session,
    UserConnection,
    WsContext,
    WsData,
    WsResponseData,
} from '#vendor/types/types.js'

import logger from '#vendor/utils/logger.js'
import { connectionSignal } from '#vendor/utils/network/ws-connection-signal.js'
import { randomUUID } from 'crypto'

export default (
    wsData: WsData,
    responseData: WsResponseData,
    userData: UserConnection | null,
    _session: Session | null,
): WsContext => {
    const requestId = randomUUID()
    const requestLogger = logger.child({
        requestId,
        ...(userData?.userId !== undefined ? { userId: userData.userId } : {}),
    }) as unknown as WsContext['logger']

    return {
        requestId,
        logger: requestLogger,
        ws: wsData.ws,
        wsData,
        responseData,
        userData,
        session: null,
        auth: null,
        signal: connectionSignal(wsData.ws),
    }
}
