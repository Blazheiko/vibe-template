import { useEventBus } from '@/utils/event-bus'
import { reportValidationFailure } from '@/utils/sentry-payload-summary'
import {
    isAdminUserOnlineRemovePayload,
    isSupportChatCompletePayload,
    isSupportChatErrorPayload,
    isSupportChatTokenPayload,
    isWSAdminUserOnlineUpsertPayload,
} from '@/utils/ws-payload-guards'
import type { WebsocketMessage } from '@/utils/websocket-types'

export const useBroadcastHandler = () => {
    const eventBus = useEventBus()

    const handlers: Partial<Record<string, (event: WebsocketMessage) => void>> = {
        support_chat_token: (event) => {
            const payload = event.payload
            if (!isSupportChatTokenPayload(payload)) {
                reportValidationFailure('support_chat_token', 'payload_shape', payload)
                return
            }
            eventBus.emit('support_chat_token', {
                token: payload.token,
                ...(payload.clientMessageId !== undefined
                    ? { clientMessageId: payload.clientMessageId }
                    : {}),
            })
        },
        support_chat_complete: (event) => {
            const payload = event.payload
            if (!isSupportChatCompletePayload(payload)) {
                reportValidationFailure('support_chat_complete', 'payload_shape', payload)
                return
            }
            eventBus.emit('support_chat_complete', {
                content: payload.content,
                screenshots: payload.screenshots,
                ...(payload.clientMessageId !== undefined
                    ? { clientMessageId: payload.clientMessageId }
                    : {}),
            })
        },
        support_chat_error: (event) => {
            const payload = event.payload
            if (!isSupportChatErrorPayload(payload)) {
                reportValidationFailure('support_chat_error', 'payload_shape', payload)
                return
            }
            eventBus.emit('support_chat_error', {
                message: payload.message,
                ...(payload.code !== undefined ? { code: payload.code } : {}),
                ...(payload.clientMessageId !== undefined
                    ? { clientMessageId: payload.clientMessageId }
                    : {}),
            })
        },
        admin_user_online_upsert: (event) => {
            const payload = event.payload
            if (!isWSAdminUserOnlineUpsertPayload(payload)) {
                reportValidationFailure('admin_user_online_upsert', 'payload_shape', payload)
                return
            }
            eventBus.emit('admin_user_online_upsert', {
                id: payload.id,
                name: payload.name,
                email: payload.email,
                appType: payload.appType,
                userAgent: payload.userAgent,
                connectionsCount: payload.connectionsCount,
            })
        },
        admin_user_online_remove: (event) => {
            const payload = event.payload
            if (!isAdminUserOnlineRemovePayload(payload)) {
                reportValidationFailure('admin_user_online_remove', 'payload_shape', payload)
                return
            }
            eventBus.emit('admin_user_online_remove', { id: payload.id })
        },
    }

    const handleBroadcast = (event: WebsocketMessage): void => {
        const handler = handlers[event.event.replace(/^broadcast:/, '')]
        if (handler) {
            handler(event)
        }
    }

    return { handleBroadcast }
}
