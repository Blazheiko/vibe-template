import { executeWsMiddlewares } from '#vendor/utils/middlewares/core/execute-httpMiddlewares.js'
// import validators from '#vendor/start/validators.js';
import type {
    Session,
    WsData,
    WsMessage,
    WsResponseData,
    MyWebSocket,
    UserConnection,
    // ValidatorFunction,
    Payload,
    WsRoutes,
} from '#vendor/types/types.js'
import createWsContext from '../context/ws-context.js'
import checkRateLimitWs, { createWsRateLimitErrorResponse } from '../rate-limit/ws-rate-limit.js'
import {
    classifiedErrorBody,
    classifyError,
    logClassifiedError,
} from '#vendor/utils/network/errors/classify-error.js'
import { validateRoutePayload } from '#vendor/utils/validation/validate-route-payload.js'
import logger from '#vendor/utils/logger.js'
import { isEmptyPayload } from '#vendor/utils/network/response-body.js'
import { createWsErrorEnvelope, setWsError } from '#vendor/utils/network/ws-error-envelope.js'

export default async (
    message: WsMessage,
    ws: MyWebSocket,
    userData: UserConnection,
    session: Session,
    wsRoutesByUrl: Readonly<WsRoutes>,
): Promise<WsResponseData> => {
    const responseData: WsResponseData = {
        // null until the handler answers: an error or a stopped middleware sends no data.
        data: null,
        event: message.event,
        // Echoed in every outcome (ADR 0006): the client waits for its reply under this id.
        ...(message.id !== undefined ? { id: message.id } : {}),
        timestamp: message.timestamp,
        status: '200',
        error: null,
    }
    let requestId: string | undefined
    let userId: string | undefined
    let routePath: string | undefined
    try {
        const event = message.event
        const nameRoute = event.split(':')[0]
        if (nameRoute === undefined) {
            throw new Error('Invalid event')
        }
        // Own properties only: a map built as a plain object would answer `constructor` with
        // Object itself (feat-149).
        const route = Object.hasOwn(wsRoutesByUrl, nameRoute) ? wsRoutesByUrl[nameRoute] : undefined
        if (route !== undefined) {
            routePath = route.url
            // Check rate limit before processing
            const rateLimitResult = checkRateLimitWs(ws, route, route.groupRateLimit)

            if (!rateLimitResult.allowed) {
                // Rate limit exceeded - return error response
                return {
                    ...createWsRateLimitErrorResponse(
                        rateLimitResult.errorMessage ?? 'Rate limit exceeded',
                        rateLimitResult.retryAfter ?? 60,
                        message.event,
                    ),
                    ...(message.id !== undefined ? { id: message.id } : {}),
                }
            }

            const rawPayload = (message as { payload?: unknown }).payload
            let payload: Payload | null = (rawPayload as Payload | null) ?? null
            if (route.validator !== undefined) {
                payload = validateRoutePayload(route.validator, rawPayload) as Payload
            }
            const wsData: WsData = {
                ws,
                middlewareData: {},
                status: '200',
                payload:
                    payload !== null && typeof payload === 'object' && !Buffer.isBuffer(payload)
                        ? Object.freeze({ ...payload })
                        : (payload ?? {}),
            }

            // const context = { wsData, responseData , session : null , auth: null};
            const context = createWsContext(wsData, responseData, userData, session)
            requestId = context.requestId
            userId = userData.userId
            if (
                route.middlewares === undefined ||
                !Array.isArray(route.middlewares) ||
                route.middlewares.length === 0 ||
                (await executeWsMiddlewares(route.middlewares, context))
            ) {
                const handler = route.handler
                responseData.data = await handler(context)
                // Runtime ResponseSchema check (feat-044 §4.3.2, feat-046 §4.3). Only
                // this direct reply is checked, not later async messages or broadcasts.
                if (route.responseCheck !== null && !isEmptyPayload(responseData.data)) {
                    const result = route.responseCheck(responseData.data, {
                        route: route.url,
                        transport: 'ws',
                        requestId,
                    })
                    if (result.ok) {
                        responseData.data = result.payload as typeof responseData.data
                    } else {
                        setWsError(
                            responseData,
                            createWsErrorEnvelope('internal_error', 'Internal server error'),
                        )
                    }
                }
            }

            return responseData
        }
        setWsError(responseData, createWsErrorEnvelope('not_found', 'Route not found'))
    } catch (e: unknown) {
        const classified = classifyError(e)
        logClassifiedError(
            logger.child({ requestId, userId, route: routePath, wsEvent: message.event }),
            classified,
        )
        const { code, message: text, details } = classifiedErrorBody(classified)
        setWsError(
            responseData,
            createWsErrorEnvelope(code, text, details !== undefined ? { details } : undefined),
        )
    }

    return responseData
}
