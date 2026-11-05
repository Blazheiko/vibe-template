import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HttpContext } from '#vendor/types/types.js'

const pushSubscriptionServiceMock = {
    getSubscription: vi.fn(),
    updateSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    getSubscriptionLogs: vi.fn(),
    getSubscriptionStatistics: vi.fn(),
    deactivateSubscription: vi.fn(),
}

vi.mock('#app/services/notifications/push-subscription-service.js', () => ({
    pushSubscriptionService: pushSubscriptionServiceMock,
}))
const pushNotificationSenderServiceMock = { isConfigured: vi.fn(), sendToUser: vi.fn() }
vi.mock('#app/services/notifications/push-notification-sender-service.js', () => ({
    pushNotificationSenderService: pushNotificationSenderServiceMock,
}))

const { default: PushSubscriptionController } = await import('./push-subscription-controller.js')

const contextWithParam = (subscriptionId: string): HttpContext =>
    ({
        auth: { check: () => true, getUserId: () => '7' },
        httpData: { params: { subscriptionId }, payload: {} },
        responseData: { status: 200, payload: null, headers: [], cookies: [] },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        signal: new AbortController().signal,
    }) as unknown as HttpContext

afterEach(() => {
    vi.clearAllMocks()
})

describe('PushSubscriptionController :subscriptionId', () => {
    // GET /push-subscriptions/test-push now lands on GET /:subscriptionId (item 48).
    it.each([['test-push'], ['12abc'], ['-1'], ['']])(
        'answers 404 for a non-numeric id %j without calling the service',
        async (subscriptionId) => {
            const context = contextWithParam(subscriptionId)

            await PushSubscriptionController.getSubscription(context)

            expect(context.responseData.status).toBe(404)
            expect(pushSubscriptionServiceMock.getSubscription).not.toHaveBeenCalled()
        },
    )

    it('passes a numeric id to the service as bigint', async () => {
        pushSubscriptionServiceMock.getSubscription.mockResolvedValue({
            _tag: 'Ok',
            value: { data: { id: '5' } },
        })
        const context = contextWithParam('5')

        await PushSubscriptionController.getSubscription(context)

        expect(pushSubscriptionServiceMock.getSubscription).toHaveBeenCalledWith(7n, 5n)
    })
})

// feat-129: a logout in another tab deletes the session record after auth_guard let the request in.
describe('PushSubscriptionController.testPush', () => {
    const testPushContext = (stored: boolean) => {
        const isStored = vi.fn(() => Promise.resolve(stored))
        const context = {
            ...(contextWithParam('') as object),
            httpData: { params: {}, payload: {} },
            session: { isStored },
        } as unknown as Parameters<typeof PushSubscriptionController.testPush>[0]
        return { context, isStored }
    }

    it('answers 401 and pushes nothing when the session record is gone', async () => {
        pushNotificationSenderServiceMock.isConfigured.mockReturnValue(true)
        const { context, isStored } = testPushContext(false)

        const response = await PushSubscriptionController.testPush(context)

        expect(isStored).toHaveBeenCalledOnce()
        expect(context.responseData.status).toBe(401)
        expect(response).toMatchObject({ status: 'error', code: 'unauthorized' })
        expect(pushNotificationSenderServiceMock.sendToUser).not.toHaveBeenCalled()
    })

    it('pushes while the session record is there', async () => {
        pushNotificationSenderServiceMock.isConfigured.mockReturnValue(true)
        pushNotificationSenderServiceMock.sendToUser.mockResolvedValue({ sent: 1, failed: 0 })
        const { context } = testPushContext(true)

        const response = await PushSubscriptionController.testPush(context)

        expect(pushNotificationSenderServiceMock.sendToUser).toHaveBeenCalledOnce()
        expect(response).toMatchObject({ status: 'success', sent: 1, failed: 0 })
    })
})
