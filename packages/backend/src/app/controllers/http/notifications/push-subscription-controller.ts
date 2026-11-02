import type { HttpContext } from '#vendor/types/types.js'
import { Result } from 'better-result'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
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
        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return {
            status: 'success',
            subscriptions: result.value.subscriptions,
        }
    },

    async createSubscription(
        context: HttpContext<CreateSubscriptionInput>,
    ): Promise<CreateSubscriptionResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }

        const payload = getTypedPayload(context)
        const result = await pushSubscriptionService.createSubscription(userId, payload)

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return {
            status: 'success',
            subscription: result.value.subscription,
        }
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

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return {
            status: 'success',
            data: result.value.data,
        }
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
        )

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return {
            status: 'success',
            subscription: result.value.subscription,
        }
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

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'success', message: result.value.message }
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

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return { status: 'success', data: result.value.data }
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

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return {
            status: 'success',
            data: result.value.data,
        }
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

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        return {
            status: 'success',
            data: result.value.data,
        }
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
