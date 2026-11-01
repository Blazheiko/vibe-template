import type { HttpContext } from '#vendor/types/types.js'
import { applyAppErrorStatus } from '#app/services/shared/apply-service-status.js'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { knowledgeBaseService } from '#app/services/support/knowledge-base-service.js'
import { supportService } from '#app/services/support/support-service.js'
import { badRequest, notFound, unauthorized } from '#app/services/shared/errors.js'
import type {
    SupportGetChatHistoryResponse,
    SupportDeleteChatHistoryResponse,
    SupportScreenshotResponse,
} from 'shared/responses'
import { Result } from 'better-result'
import type { SupportChatHistoryQuery } from 'shared/schemas'

function getUserId<TQuery>(context: HttpContext<unknown, TQuery>): bigint | null {
    if (!context.auth.check()) {
        applyAppErrorStatus(context.responseData, unauthorized())
        return null
    }
    const id = context.auth.getUserId()
    if (id === null) {
        applyAppErrorStatus(context.responseData, unauthorized())
        return null
    }
    return BigInt(id)
}

export default {
    async getChatHistory(
        context: HttpContext<unknown, SupportChatHistoryQuery>,
    ): Promise<SupportGetChatHistoryResponse> {
        const userId = getUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const { before, limit } = context.httpData.query
        const result = await supportService.getChatHistory(userId, { before, limit })
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'ok', data: result.value.data, hasMore: result.value.hasMore }
    },

    async deleteChatHistory(context: HttpContext): Promise<SupportDeleteChatHistoryResponse> {
        const userId = getUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await supportService.deleteChatHistory(userId)
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }
        return { status: 'ok' }
    },

    async getScreenshot(context: HttpContext): Promise<SupportScreenshotResponse> {
        const userId = getUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())

        const articleIdStr = context.httpData.params['articleId']
        if (articleIdStr === undefined) {
            return mapControllerError(context, badRequest('Missing articleId'))
        }

        let articleId: bigint
        try {
            articleId = BigInt(articleIdStr)
        } catch {
            return mapControllerError(context, badRequest('Invalid articleId'))
        }

        const screenshotKeyResult = await knowledgeBaseService.getScreenshotUrl(articleId)
        if (Result.isError(screenshotKeyResult)) {
            return mapControllerError(context, screenshotKeyResult.error)
        }

        // Always a CDN_URL address: support images must come only from our own CDN.
        const url = screenshotKeyResult.value.url
        if (url === null) {
            return mapControllerError(context, notFound('Screenshot', 'Screenshot not found'))
        }

        context.responseData.status = 302
        context.responseData.setHeader('Location', url)
        return { status: 'redirect' }
    },
}
