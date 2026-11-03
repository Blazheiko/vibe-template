import type { HttpContext } from '#vendor/types/types.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import { pushSubscriptionService } from '#app/services/notifications/push-subscription-service.js'
import { pushNotificationSenderService } from '#app/services/notifications/push-notification-sender-service.js'
import {
    internalMessage,
    notFound,
    unauthorized,
    type AppError,
} from '#app/services/shared/errors.js'
import type {
    GetSubscriptionsResponse,
    CreateSubscriptionResponse,
    GetSubscriptionResponse,
    UpdateSubscriptionResponse,
    DeleteSubscriptionResponse,
    GetSubscriptionLogsResponse,
    GetSubscriptionStatisticsResponse,
    DeactivateSubscriptionResponse,
    GetVapidPublicKeyResponse,
    TestPushResponse,
} from 'shared'
import type {
    CreateSubscriptionInput,
    EmptyFormInput,
    PushSubscriptionTestInput,
    UpdateSubscriptionInput,
} from 'shared/schemas'

// Non-numeric ids (e.g. GET /test-push, which now only exists as POST) are the
// same "not found" as someone else's subscription, instead of a BigInt 500.
function resolveSubscriptionId(context: HttpContext<unknown, unknown>): bigint | null {
    const raw = context.httpData.params['subscriptionId'] ?? ''
    return /^\d+$/.test(raw) ? BigInt(raw) : null
}

const subscriptionNotFound = (): AppError => notFound('Subscription', 'Subscription not found')

export default {
    async getVapidPublicKey(context: HttpContext): Promise<GetVapidPublicKeyResponse> {
        const vapidPublicKey = pushNotificationSenderService.getVapidPublicKey()
        if (vapidPublicKey === '') {
            return mapControllerError(context, internalMessage('VAPID keys not configured'))
        }

        return Promise.resolve({ status: 'success', vapidPublicKey })
    },

    async getSubscriptions(context: HttpContext): Promise<GetSubscriptionsResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const result = await pushSubscriptionService.getSubscriptions(userId)
        return respond(context, result, (value) => ({
            status: 'success',
            subscriptions: value.subscriptions,
        }))
    },

    async createSubscription(
        context: HttpContext<CreateSubscriptionInput>,
    ): Promise<CreateSubscriptionResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await pushSubscriptionService.createSubscription(
            userId,
            payload,
            context.auth.getPresentedUserToken(),
        )
        return respond(context, result, (value) => ({
            status: 'success',
            subscription: value.subscription,
        }))
    },

    async getSubscription(context: HttpContext): Promise<GetSubscriptionResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const subscriptionId = resolveSubscriptionId(context)
        if (subscriptionId === null) {
            return mapControllerError(context, subscriptionNotFound())
        }
        const result = await pushSubscriptionService.getSubscription(userId, subscriptionId)
        return respond(context, result, (value) => ({
            status: 'success',
            data: value.data,
        }))
    },

    async updateSubscription(
        context: HttpContext<UpdateSubscriptionInput>,
    ): Promise<UpdateSubscriptionResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const subscriptionId = resolveSubscriptionId(context)
        if (subscriptionId === null) {
            return mapControllerError(context, subscriptionNotFound())
        }
        const payload = getTypedPayload(context)

        const result = await pushSubscriptionService.updateSubscription(
            userId,
            subscriptionId,
            payload,
            context.auth.getPresentedUserToken(),
        )
        return respond(context, result, (value) => ({
            status: 'success',
            subscription: value.subscription,
        }))
    },

    async deleteSubscription(context: HttpContext): Promise<DeleteSubscriptionResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const subscriptionId = resolveSubscriptionId(context)
        if (subscriptionId === null) {
            return mapControllerError(context, subscriptionNotFound())
        }
        const result = await pushSubscriptionService.deleteSubscription(userId, subscriptionId)
        return respond(context, result, (value) => ({ status: 'success', message: value.message }))
    },

    async getSubscriptionLogs(context: HttpContext): Promise<GetSubscriptionLogsResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const subscriptionId = resolveSubscriptionId(context)
        if (subscriptionId === null) {
            return mapControllerError(context, subscriptionNotFound())
        }
        const result = await pushSubscriptionService.getSubscriptionLogs(userId, subscriptionId)
        return respond(context, result, (value) => ({ status: 'success', data: value.data }))
    },

    async getSubscriptionStatistics(
        context: HttpContext,
    ): Promise<GetSubscriptionStatisticsResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const subscriptionId = resolveSubscriptionId(context)
        if (subscriptionId === null) {
            return mapControllerError(context, subscriptionNotFound())
        }
        const result = await pushSubscriptionService.getSubscriptionStatistics(
            userId,
            subscriptionId,
        )
        return respond(context, result, (value) => ({
            status: 'success',
            data: value.data,
        }))
    },

    async deactivateSubscription(
        context: HttpContext<EmptyFormInput>,
    ): Promise<DeactivateSubscriptionResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const subscriptionId = resolveSubscriptionId(context)
        if (subscriptionId === null) {
            return mapControllerError(context, subscriptionNotFound())
        }
        const result = await pushSubscriptionService.deactivateSubscription(userId, subscriptionId)
        return respond(context, result, (value) => ({
            status: 'success',
            data: value.data,
        }))
    },

    async testPush(context: HttpContext<PushSubscriptionTestInput>): Promise<TestPushResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        if (!pushNotificationSenderService.isConfigured()) {
            return mapControllerError(context, internalMessage('VAPID keys not configured'))
        }

        const payload = getTypedPayload(context)
        const title = payload.title ?? 'Test Push'
        const body = payload.body ?? 'This is a test push notification'

        const result = await pushNotificationSenderService.sendToUser(userId, {
            title,
            body,
            url: '/',
            tag: 'test-push',
            data: { type: 'test' },
        })

        return {
            status: 'success',
            message: `Sent: ${String(result.sent)}, Failed: ${String(result.failed)}`,
            sent: result.sent,
            failed: result.failed,
        }
    },
}
