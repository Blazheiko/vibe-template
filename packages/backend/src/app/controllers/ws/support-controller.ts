import { Result } from 'better-result'
import type { WsContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { supportService } from '#app/services/support/support-service.js'
import { appErrorToWsError } from '#app/services/shared/ws-error.js'
import { appErrorStatus, unauthorized, type AppError } from '#app/services/shared/errors.js'
import type { SupportChatInput, SupportOpenChatInput } from 'shared/schemas'
import type { SupportChatResponse, SupportOpenChatResponse } from 'shared/responses'

// The answer to the request is the admission verdict: `ok` only once the message has
// been accepted (it passed the per-user limit and holds the user's lock). A refusal is the
// reply itself (429), not an `ok` followed by silence. What goes wrong after `ok` reaches
// the client as the `support_chat_error` event.
const refuse = (context: WsContext, error: AppError): ReturnType<typeof appErrorToWsError> => {
    context.responseData.status = String(appErrorStatus(error))
    return appErrorToWsError(error)
}

export default {
    async openChat(context: WsContext<SupportOpenChatInput>): Promise<SupportOpenChatResponse> {
        const { userData } = context
        if (userData?.userId === undefined) {
            return appErrorToWsError(unauthorized())
        }

        const payload = getTypedPayload(context)
        const userId = BigInt(userData.userId)

        const admission = await supportService.admitOpenChat(userId)
        if (Result.isError(admission)) return refuse(context, admission.error)

        void supportService.runOpenChat(
            admission.value,
            userId,
            userData.uuid,
            context.signal,
            payload.language,
        )

        return { status: 'ok' }
    },

    async chat(context: WsContext<SupportChatInput>): Promise<SupportChatResponse> {
        const { userData } = context
        if (userData?.userId === undefined) {
            return appErrorToWsError(unauthorized())
        }

        const payload = getTypedPayload(context)
        const userId = BigInt(userData.userId)

        const admission = await supportService.admitChat(userId)
        if (Result.isError(admission)) return refuse(context, admission.error)

        void supportService.runChat(
            admission.value,
            userId,
            payload.message,
            userData.uuid,
            context.signal,
            payload.language,
            payload.clientMessageId,
        )

        return { status: 'ok' }
    },
}
