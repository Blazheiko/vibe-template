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

    testHeaders({ httpData, logger }: HttpContext): TestHeadersResponse {
        logger.info('testHeaders')
        return mainService.testHeaders(httpData)
    },

    getSetCookies({ httpData, logger }: HttpContext): GetSetCookiesResponse {
        logger.info('testCookies')
        return mainService.getSetCookies(httpData)
    },

    testSession({ session, httpData, logger }: HttpContext): TestSessionResponse {
        logger.info('testSession')
        return mainService.testSession(httpData, session.sessionInfo ?? null)
    },

    async updateWsToken(context: HttpContext): Promise<UpdateWsTokenResponse> {
        context.logger.info('updateWsToken')

        const result = await mainService.updateWsToken(context.session.sessionInfo ?? null)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'ok', ...result.value }
    },

    async init(context: HttpContext): Promise<InitResponse> {
        context.logger.info('init')

        const result = await mainService.init(context.session.sessionInfo ?? null)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'ok', ...result.value }
    },

    setHeaderAndCookie({ responseData, logger }: HttpContext): SetHeaderAndCookieResponse {
        logger.info('set-header-and-cookie')
        return mainService.setHeaderAndCookie(responseData)
    },

    testMiddleware({ responseData, logger }: HttpContext): TestMiddlewareResponse {
        logger.info('testMiddleware controller')
        return mainService.testMiddleware(responseData)
    },

    testMiddleware2({ responseData, logger }: HttpContext): TestMiddlewareResponse {
        logger.info('testMiddleware2 controller')
        return mainService.testMiddleware(responseData)
    },

    testMiddleware3({ responseData, logger }: HttpContext): TestMiddlewareResponse {
        logger.info('testMiddleware3 controller')
        return mainService.testMiddleware(responseData)
    },
}
