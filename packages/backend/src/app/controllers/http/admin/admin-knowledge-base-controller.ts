import { Result } from 'better-result'
import type { HttpContext } from '#vendor/types/types.js'
import { knowledgeBaseService } from '#app/services/support/knowledge-base-service.js'
import type {
    SupportKnowledgeBaseDeleteResponse,
    SupportKnowledgeBaseInitResponse,
    SupportKnowledgeBaseItemResponse,
    SupportKnowledgeBaseListResponse,
    SupportKnowledgeBaseReindexResponse,
} from 'shared/responses'
import type {
    AdminKnowledgeBaseListQuery,
    EmptyFormInput,
    SupportKnowledgeBaseCreateInput,
    SupportKnowledgeBaseUpdateInput,
} from 'shared/schemas'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { badRequest, conflict } from '#app/services/shared/errors.js'
import { knowledgeBaseInitService } from '#app/services/support/knowledge-base-init-service.js'

function parseId(context: HttpContext<unknown, unknown>): bigint | null {
    const idStr = context.httpData.params['id']
    if (idStr === undefined) return null
    try {
        return BigInt(idStr)
    } catch {
        return null
    }
}

export default {
    async getAll(
        context: HttpContext<unknown, AdminKnowledgeBaseListQuery>,
    ): Promise<SupportKnowledgeBaseListResponse> {
        const query = context.httpData.query

        const result = await knowledgeBaseService.getAll({
            ...(query.category !== undefined ? { category: query.category } : {}),
            page: query.page,
            limit: query.limit,
        })
        return respond(context, result, (value) => ({
            status: 'ok',
            data: value.items,
            total: value.total,
        }))
    },

    async getById(context: HttpContext): Promise<SupportKnowledgeBaseItemResponse> {
        const id = parseId(context)
        if (id === null) return mapControllerError(context, badRequest('Invalid ID'))

        const result = await knowledgeBaseService.getById(id)
        return respond(context, result, (value) => ({ status: 'ok', data: value.item }))
    },

    async create(
        context: HttpContext<SupportKnowledgeBaseCreateInput>,
    ): Promise<SupportKnowledgeBaseItemResponse> {
        const payload = getTypedPayload(context)
        const result = await knowledgeBaseService.create({
            title: payload.title,
            content: payload.content,
            category: payload.category ?? null,
            isActive: payload.isActive ?? true,
        })
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }
        context.responseData.status = 201
        return { status: 'ok', data: result.value.item }
    },

    async update(
        context: HttpContext<SupportKnowledgeBaseUpdateInput>,
    ): Promise<SupportKnowledgeBaseItemResponse> {
        const id = parseId(context)
        if (id === null) return mapControllerError(context, badRequest('Invalid ID'))

        const payload = getTypedPayload(context)
        const result = await knowledgeBaseService.update(id, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.content !== undefined ? { content: payload.content } : {}),
            ...(payload.category !== undefined ? { category: payload.category } : {}),
            ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
        })
        return respond(context, result, (value) => ({ status: 'ok', data: value.item }))
    },

    async delete(context: HttpContext): Promise<SupportKnowledgeBaseDeleteResponse> {
        const id = parseId(context)
        if (id === null) return mapControllerError(context, badRequest('Invalid ID'))

        const result = await knowledgeBaseService.delete(id)
        return respond(context, result, () => ({ status: 'ok' }))
    },

    async uploadScreenshot(
        context: HttpContext<EmptyFormInput>,
    ): Promise<SupportKnowledgeBaseItemResponse> {
        const id = parseId(context)
        if (id === null) return mapControllerError(context, badRequest('Invalid ID'))

        const file = context.httpData.files?.get('screenshot')
        const result = await knowledgeBaseService.uploadScreenshot(id, file)
        return respond(context, result, (value) => ({ status: 'ok', data: value.item }))
    },

    async deleteScreenshot(context: HttpContext): Promise<SupportKnowledgeBaseItemResponse> {
        const id = parseId(context)
        if (id === null) return mapControllerError(context, badRequest('Invalid ID'))

        const result = await knowledgeBaseService.deleteScreenshot(id)
        return respond(context, result, (value) => ({ status: 'ok', data: value.item }))
    },

    async reindex(
        context: HttpContext<EmptyFormInput>,
    ): Promise<SupportKnowledgeBaseReindexResponse> {
        const id = parseId(context)
        if (id === null) return mapControllerError(context, badRequest('Invalid ID'))

        const result = await knowledgeBaseService.reindexArticle(id)
        return respond(context, result, (value) => ({ status: 'ok', indexed: value.indexed }))
    },

    async reindexAll(
        context: HttpContext<EmptyFormInput>,
    ): Promise<SupportKnowledgeBaseReindexResponse> {
        const result = await knowledgeBaseService.reindexAll()
        return respond(context, result, (value) => ({ status: 'ok', indexed: value.indexed }))
    },

    async startInit(
        context: HttpContext<EmptyFormInput>,
    ): Promise<SupportKnowledgeBaseInitResponse> {
        const result = await knowledgeBaseInitService.start()
        if (!result.ok) {
            const error = mapControllerError(
                context,
                result.errorCode === 'ALREADY_RUNNING'
                    ? conflict(result.message)
                    : badRequest(result.message),
            )
            return {
                ...error,
                data: result.status,
            }
        }

        context.responseData.status = 202
        return { status: 'ok', data: result.status }
    },

    getInitStatus(): SupportKnowledgeBaseInitResponse {
        return {
            status: 'ok',
            data: knowledgeBaseInitService.getStatus(),
        }
    },
}
