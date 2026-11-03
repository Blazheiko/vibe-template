import type { Auth, HttpContext, HttpData, ResponseData, Session } from '#vendor/types/types.js'

import logger from '#vendor/utils/logger.js'
import { randomUUID } from 'crypto'

const getDefaultSession = (): Session => {
    return {
        sessionInfo: null,
        updateSessionData: async () => Promise.resolve(null),
        changeSessionData: async () => Promise.resolve(null),
        destroySession: async () => Promise.resolve(),
    }
}
const getDefaultAuth = (): Auth => ({
    getUserId: () => null,
    getPresentedUserToken: () => undefined,
    check: () => false,
    login: () => Promise.resolve(false),
    logout: () => Promise.resolve(false),
    logoutAll: () => Promise.resolve({ deleted: 0, complete: true }),
})

export default (
    httpData: HttpData,
    responseData: ResponseData,
    signal: AbortSignal = new AbortController().signal,
    requestId: string = randomUUID(),
): HttpContext => {
    const requestLogger = logger.child({
        requestId,
    }) as unknown as HttpContext['logger']

    return {
        requestId,
        logger: requestLogger,
        httpData,
        responseData,
        session: getDefaultSession(),
        auth: getDefaultAuth(),
        signal,
    }
}
