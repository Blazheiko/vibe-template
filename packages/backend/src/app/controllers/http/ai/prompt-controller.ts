import { Result } from 'better-result'
import type { HttpContext } from '#vendor/types/types.js'
import type { ParamsOf } from '#app/routing/contract-registry.js'
import type { promptContracts } from 'shared/contracts'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import {
    promptService,
    type PromptType,
    type PromptUpdate,
} from '#app/services/ai/prompt-service.js'
import { promptTestService } from '#app/services/ai/prompt-test-service.js'
import { badRequest, notFound } from '#app/services/shared/errors.js'
import type { PromptTestInput, PromptUpdateInput } from 'shared/schemas'
import type {
    PromptGetListResponse,
    PromptGetByTypeResponse,
    PromptUpdateResponse,
    PromptTestResponse,
} from 'shared'
import { promptTransformer } from '#app/transformers/index.js'

const PROMPT_TYPES: PromptType[] = [
    'SUPPORT_SYSTEM',
    'SUPPORT_FIRST_CHAT',
    'SUPPORT_QUERY_TRANSLATION',
]

function isPromptType(value: string): value is PromptType {
    return (PROMPT_TYPES as string[]).includes(value)
}

export default {
    list(_context: HttpContext): PromptGetListResponse {
        return {
            status: 'success',
            data: promptTransformer.serializeArray(
                promptService.all().filter((prompt) => isPromptType(prompt.type)),
            ),
        }
    },

    getByType(
        context: HttpContext<unknown, null, ParamsOf<typeof promptContracts.get>>,
    ): PromptGetByTypeResponse {
        const { type } = context.httpData.params
        if (!isPromptType(type)) {
            return mapControllerError(context, badRequest(`Unknown prompt type: ${type}`))
        }
        const prompt = promptService.get(type)
        if (prompt === undefined) {
            return mapControllerError(context, notFound('Prompt', 'Prompt not found'))
        }
        return { status: 'success', data: promptTransformer.serialize(prompt) }
    },

    async testPrompt(
        context: HttpContext<PromptTestInput, null, ParamsOf<typeof promptContracts.test>>,
    ): Promise<PromptTestResponse> {
        const { type } = context.httpData.params
        if (!isPromptType(type)) {
            return mapControllerError(context, badRequest(`Unknown prompt type: ${type}`))
        }

        const prompt = promptService.get(type)
        if (prompt === undefined) {
            return mapControllerError(context, notFound('Prompt', 'Prompt not found'))
        }

        const { message } = getTypedPayload(context)

        // context.signal: a client that went away cancels the provider call.
        const adminId = context.auth.getUserId()
        const result = await promptTestService.run(prompt.content, message, context.signal, {
            userId: adminId === null ? null : BigInt(adminId),
            llmSystemPromptId: prompt.id,
        })
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }
        return { status: 'success', result: result.value }
    },

    async update(
        context: HttpContext<PromptUpdateInput, null, ParamsOf<typeof promptContracts.update>>,
    ): Promise<PromptUpdateResponse> {
        const { type } = context.httpData.params
        if (!isPromptType(type)) {
            return mapControllerError(context, badRequest(`Unknown prompt type: ${type}`))
        }

        const payload = getTypedPayload(context)
        const updateData: PromptUpdate = {}

        if (payload.content !== undefined) updateData.content = payload.content
        if ('model' in payload) updateData.model = payload.model ?? null
        if ('temperature' in payload) updateData.temperature = payload.temperature ?? null
        if ('maxTokens' in payload) updateData.maxTokens = payload.maxTokens ?? null

        if (Object.keys(updateData).length === 0) {
            return mapControllerError(context, badRequest('Nothing to update'))
        }

        const ok = await promptService.update(type, updateData)
        if (!ok) {
            return mapControllerError(
                context,
                notFound('Prompt', 'Prompt not found or not updated'),
            )
        }
        return { status: 'success' }
    },
}
