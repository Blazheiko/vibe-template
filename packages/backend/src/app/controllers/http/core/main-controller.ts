import type { HttpContext } from '#vendor/types/types.js'
import { readinessService } from '#app/services/core/readiness-service.js'
import { mainService } from '#app/services/core/main-service.js'
import { respond } from '#app/controllers/shared/controller-error.js'
import type {
    InitResponse,
    PingResponse,
    ReadyResponse,
    SetHeaderAndCookieResponse,
    TestMiddlewareResponse,
    UpdateWsTokenResponse,
} from 'shared'

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

    async updateWsToken(context: HttpContext): Promise<UpdateWsTokenResponse> {
        const result = await mainService.updateWsToken(context.session.sessionInfo ?? null)
        return respond(context, result, (value) => ({ status: 'ok', ...value }))
    },

    async init(context: HttpContext): Promise<InitResponse> {
        const result = await mainService.init(context.session.sessionInfo ?? null)
        return respond(context, result, (value) => ({ status: 'ok', ...value }))
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
