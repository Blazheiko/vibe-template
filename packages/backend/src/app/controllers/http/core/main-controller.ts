import type { HttpContext } from '#vendor/types/types.js'
import { readinessService } from '#app/services/core/readiness-service.js'
import { mainService } from '#app/services/core/main-service.js'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import type {
    InitResponse,
    PingResponse,
    ReadyResponse,
    TestHeadersResponse,
    GetSetCookiesResponse,
    TestSessionResponse,
    SetHeaderAndCookieResponse,
    TestMiddlewareResponse,
    UpdateWsTokenResponse,
} from 'shared'
import { Result } from 'better-result'

export default {
    ping(): PingResponse {
        return mainService.ping()
    },

    async ready(context: HttpContext): Promise<ReadyResponse> {
        const { ready } = await readinessService.check()
        if (!ready) {
            context.responseData.status = 503
            return { status: 'unavailable' }
        }
        return { status: 'ok' }
    },

    testHeaders({ httpData }: HttpContext): TestHeadersResponse {
        return mainService.testHeaders(httpData)
    },

    getSetCookies({ httpData }: HttpContext): GetSetCookiesResponse {
        return mainService.getSetCookies(httpData)
    },

    testSession({ session, httpData }: HttpContext): TestSessionResponse {
        return mainService.testSession(httpData, session.sessionInfo ?? null)
    },

    async updateWsToken(context: HttpContext): Promise<UpdateWsTokenResponse> {
        const result = await mainService.updateWsToken(context.session.sessionInfo ?? null)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'ok', ...result.value }
    },

    async init(context: HttpContext): Promise<InitResponse> {
        const result = await mainService.init(context.session.sessionInfo ?? null)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'ok', ...result.value }
    },

    setHeaderAndCookie({ responseData }: HttpContext): SetHeaderAndCookieResponse {
        return mainService.setHeaderAndCookie(responseData)
    },

    testMiddleware({ responseData }: HttpContext): TestMiddlewareResponse {
        return mainService.testMiddleware(responseData)
    },

    testMiddleware2({ responseData }: HttpContext): TestMiddlewareResponse {
        return mainService.testMiddleware(responseData)
    },

    testMiddleware3({ responseData }: HttpContext): TestMiddlewareResponse {
        return mainService.testMiddleware(responseData)
    },
}
