import type { HttpContext } from '#vendor/types/types.js'
import type { ParamsOf } from '#app/routing/contract-registry.js'
import type { supportContracts } from 'shared/contracts'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
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
import { parseEntityId } from '#app/controllers/shared/parse-id.js'

export default {
    async getChatHistory(
        context: HttpContext<unknown, SupportChatHistoryQuery>,
    ): Promise<SupportGetChatHistoryResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const { before, limit } = context.httpData.query
        const result = await supportService.getChatHistory(userId, { before, limit })
        return respond(context, result, (value) => ({
            status: 'ok',
            data: value.data,
            hasMore: value.hasMore,
        }))
    },

    async deleteChatHistory(context: HttpContext): Promise<SupportDeleteChatHistoryResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await supportService.deleteChatHistory(userId)
        return respond(context, result, () => ({ status: 'ok' }))
    },

    async getScreenshot(
        context: HttpContext<unknown, null, ParamsOf<typeof supportContracts.screenshot>>,
    ): Promise<SupportScreenshotResponse> {
        const userId = requireUserId(context)
        if (userId === null) return mapControllerError(context, unauthorized())

        // The router fills every segment of the contract's path; an empty or non-numeric one is
        // refused here.
        const articleId = parseEntityId(context.httpData.params.articleId)
        if (articleId === null) {
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
