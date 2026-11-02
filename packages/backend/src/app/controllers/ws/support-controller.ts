import { Result } from 'better-result'
import type { WsContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { supportService } from '#app/services/support/support-service.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import { unauthorized } from '#app/services/shared/errors.js'
import { mapWsControllerError } from '#app/controllers/shared/controller-error.js'
import type { SupportChatInput, SupportOpenChatInput } from 'shared/schemas'
import type { SupportChatResponse, SupportOpenChatResponse } from 'shared/responses'

// The answer to the request is the admission verdict: `ok` only once the message has
// been accepted (it passed the per-user limit and holds the user's lock). A refusal is the
// reply itself (429), not an `ok` followed by silence. What goes wrong after `ok` reaches
// the client as the `support_chat_error` event.

export default {
    async openChat(context: WsContext<SupportOpenChatInput>): Promise<SupportOpenChatResponse> {
        const { userData } = context
        if (userData?.userId === undefined) {
            return appErrorToPayload(unauthorized())
        }

        const payload = getTypedPayload(context)
        const userId = BigInt(userData.userId)

        const admission = await supportService.admitOpenChat(userId)
        if (Result.isError(admission)) return mapWsControllerError(context, admission.error)

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
            return appErrorToPayload(unauthorized())
        }

        const payload = getTypedPayload(context)
        const userId = BigInt(userData.userId)

        const admission = await supportService.admitChat(userId, payload.message)
        if (Result.isError(admission)) return mapWsControllerError(context, admission.error)

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
