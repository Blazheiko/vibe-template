import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn()
vi.mock('web-push', () => ({
    default: { setVapidDetails: vi.fn() },
}))
vi.mock('./push-transport.js', () => ({ sendPush: sendNotification }))
vi.mock('#config/push.js', () => ({
    default: {
        vapidPublicKey: 'pub',
        vapidPrivateKey: 'priv',
        vapidSubject: 'mailto:x@y.z',
        allowedEndpointHosts: ['fcm.googleapis.com'],
    },
}))
vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('#app/websocket/ws-connection-registry.js', () => ({
    wsConnectionRegistry: { isUserOnline: vi.fn(() => false) },
}))

const pushSubscriptionRepository = {
    findByUserId: vi.fn(),
    touchLastUsed: vi.fn(),
    deactivate: vi.fn(),
}
const pushNotificationLogRepository = { insertMany: vi.fn() }
vi.mock('#app/repositories/index.js', () => ({
    pushSubscriptionRepository,
    pushNotificationLogRepository,
}))

const { pushNotificationSenderService, PUSH_SEND_CONCURRENCY } =
    await import('./push-notification-sender-service.js')

const subscription = (id: number, extra: Record<string, unknown> = {}) => ({
    id: BigInt(id),
    userId: 7n,
    endpoint: `https://fcm.googleapis.com/fcm/send/${String(id)}`,
    p256dhKey: `p${String(id)}`,
    authKey: `a${String(id)}`,
    isActive: true,
    notificationTypes: null,
    ...extra,
})

const payload = { title: 'T', body: 'B', data: { type: 'test' } }

beforeEach(() => {
    pushNotificationLogRepository.insertMany.mockResolvedValue(undefined)
    pushSubscriptionRepository.touchLastUsed.mockResolvedValue(undefined)
    pushSubscriptionRepository.deactivate.mockResolvedValue(undefined)
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('pushNotificationSenderService.sendToUser (code-issues item 49)', () => {
    it(`sends in parallel with at most ${String(5)} requests in flight`, async () => {
        pushSubscriptionRepository.findByUserId.mockResolvedValue(
            Array.from({ length: 12 }, (_, index) => subscription(index + 1)),
        )
        let inFlight = 0
        let maxInFlight = 0
        sendNotification.mockImplementation(async () => {
            inFlight++
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 5))
            inFlight--
            return { statusCode: 201 }
        })

        const result = await pushNotificationSenderService.sendToUser(7n, payload)

        expect(PUSH_SEND_CONCURRENCY).toBe(5)
        expect(result).toEqual({ sent: 12, failed: 0 })
        expect(sendNotification).toHaveBeenCalledTimes(12)
        expect(maxInFlight).toBe(5)
    })

    it('writes all logs with one insertMany and touches lastUsed once', async () => {
        pushSubscriptionRepository.findByUserId.mockResolvedValue([
            subscription(1),
            subscription(2),
            subscription(3),
            subscription(4, { isActive: false }),
        ])
        sendNotification.mockImplementation(async (target: { endpoint: string }) => {
            if (target.endpoint.endsWith('/2')) {
                throw Object.assign(new Error('gone'), { statusCode: 410 })
            }
            return { statusCode: 201 }
        })

        const result = await pushNotificationSenderService.sendToUser(7n, payload)

        expect(result).toEqual({ sent: 2, failed: 1 })
        expect(pushNotificationLogRepository.insertMany).toHaveBeenCalledOnce()
        const rows = pushNotificationLogRepository.insertMany.mock.calls[0]?.[0] as {
            subscriptionId: bigint
            status: string
            responseData: unknown
            errorMessage?: string
            sentAt: Date
        }[]
        expect(
            rows
                .map((row) => [row.subscriptionId, row.status])
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ).toEqual([
            [1n, 'SENT'],
            [2n, 'FAILED'],
            [3n, 'SENT'],
        ])
        const failedRow = rows.find((row) => row.status === 'FAILED')
        expect(failedRow).toMatchObject({ errorMessage: 'gone', responseData: { statusCode: 410 } })
        expect(rows.every((row) => row.sentAt instanceof Date)).toBe(true)
        expect(pushSubscriptionRepository.deactivate).toHaveBeenCalledWith(2n, 7n)
        expect(pushSubscriptionRepository.touchLastUsed).toHaveBeenCalledOnce()
        const touched = pushSubscriptionRepository.touchLastUsed.mock.calls[0] as [bigint[], bigint]
        expect([...touched[0]].sort()).toEqual([1n, 3n])
        expect(touched[1]).toBe(7n)
    })

    it('keeps the result when writing the logs fails', async () => {
        pushSubscriptionRepository.findByUserId.mockResolvedValue([subscription(1)])
        sendNotification.mockResolvedValue({ statusCode: 201 })
        pushNotificationLogRepository.insertMany.mockRejectedValue(new Error('db down'))

        await expect(pushNotificationSenderService.sendToUser(7n, payload)).resolves.toEqual({
            sent: 1,
            failed: 0,
        })
    })

    it('still writes the logs when deactivating an expired subscription fails', async () => {
        pushSubscriptionRepository.findByUserId.mockResolvedValue([
            subscription(1),
            subscription(2),
        ])
        sendNotification.mockImplementation((target: { endpoint: string }) =>
            target.endpoint.endsWith('2')
                ? Promise.reject(Object.assign(new Error('gone'), { statusCode: 410 }))
                : Promise.resolve({ statusCode: 201 }),
        )
        pushSubscriptionRepository.deactivate.mockRejectedValue(new Error('db down'))

        await expect(pushNotificationSenderService.sendToUser(7n, payload)).resolves.toEqual({
            sent: 1,
            failed: 1,
        })
        expect(pushNotificationLogRepository.insertMany).toHaveBeenCalledOnce()
        expect(pushSubscriptionRepository.touchLastUsed).toHaveBeenCalledOnce()
        expect(pushSubscriptionRepository.deactivate).toHaveBeenCalledWith(2n, 7n)
    })

    it('filters by notificationType as before', async () => {
        pushSubscriptionRepository.findByUserId.mockResolvedValue([
            subscription(1, { notificationTypes: ['system'] }),
            subscription(2, { notificationTypes: ['mention'] }),
            subscription(3, { notificationTypes: [] }),
        ])
        sendNotification.mockResolvedValue({ statusCode: 201 })

        const result = await pushNotificationSenderService.sendToUser(7n, payload, {
            notificationType: 'system',
        })

        expect(result).toEqual({ sent: 2, failed: 0 })
        const endpoints = sendNotification.mock.calls.map(
            (call) => (call[0] as { endpoint: string }).endpoint,
        )
        expect(endpoints.sort()).toEqual([
            'https://fcm.googleapis.com/fcm/send/1',
            'https://fcm.googleapis.com/fcm/send/3',
        ])
    })

    it('does not write logs when nothing was sent', async () => {
        pushSubscriptionRepository.findByUserId.mockResolvedValue([])

        await expect(pushNotificationSenderService.sendToUser(7n, payload)).resolves.toEqual({
            sent: 0,
            failed: 0,
        })
        expect(pushNotificationLogRepository.insertMany).not.toHaveBeenCalled()
    })
})

// feat-104 (R03): a row stored before the allowlist (or under a wider one) gets no request.
describe('pushNotificationSenderService.sendToUser endpoint policy', () => {
    beforeEach(() => {
        sendNotification.mockReset()
        sendNotification.mockResolvedValue({ statusCode: 201 })
        pushNotificationLogRepository.insertMany.mockResolvedValue(undefined)
        pushSubscriptionRepository.touchLastUsed.mockResolvedValue(undefined)
    })

    it('skips an endpoint outside the allowlist and sends to the rest', async () => {
        pushSubscriptionRepository.findByUserId.mockResolvedValue([
            subscription(1),
            subscription(2, { endpoint: 'https://10.0.0.5/admin' }),
        ])

        const result = await pushNotificationSenderService.sendToUser(7n, {
            title: 't',
            body: 'b',
        })

        expect(result).toEqual({ sent: 1, failed: 0 })
        expect(sendNotification).toHaveBeenCalledTimes(1)
        expect((sendNotification.mock.calls[0]?.[0] as { endpoint: string }).endpoint).toBe(
            'https://fcm.googleapis.com/fcm/send/1',
        )
    })

    // feat-138 (sixth review L13), feat-139 (Q4): a deadline, and still no proxy or agent (feat-104).
    it('passes only a deadline to the transport: no proxy, no agent', async () => {
        pushSubscriptionRepository.findByUserId.mockResolvedValue([subscription(1)])
        const { PUSH_SEND_TIMEOUT_MS } = await import('./push-notification-sender-service.js')

        await pushNotificationSenderService.sendToUser(7n, { title: 't', body: 'b' })

        expect(sendNotification.mock.calls[0]?.[2]).toEqual({ deadlineMs: PUSH_SEND_TIMEOUT_MS })
        expect(PUSH_SEND_TIMEOUT_MS).toBeGreaterThan(0)
    })

    it('records a redirect answer as a failed send, without following it', async () => {
        pushSubscriptionRepository.findByUserId.mockResolvedValue([subscription(1)])
        sendNotification.mockRejectedValue(
            Object.assign(new Error('Received unexpected response code'), { statusCode: 302 }),
        )

        const result = await pushNotificationSenderService.sendToUser(7n, {
            title: 't',
            body: 'b',
        })

        expect(result).toEqual({ sent: 0, failed: 1 })
        expect(sendNotification).toHaveBeenCalledTimes(1)
        const logs = pushNotificationLogRepository.insertMany.mock.calls[0]?.[0] as {
            status: string
            responseData: unknown
        }[]
        expect(logs[0]).toMatchObject({ status: 'FAILED', responseData: { statusCode: 302 } })
    })
})

// feat-150 (review 2026-11-10): a WebPushError carries the subscription's endpoint, the answer's
// headers and its body as own fields. The log gets the status and the name of the error only.
describe('pushNotificationSenderService.sendToUser: what a failed send logs', () => {
    it('logs the status code, not the endpoint, headers or body of the push service answer', async () => {
        const { default: logger } = await import('#logger')
        pushSubscriptionRepository.findByUserId.mockResolvedValue([subscription(1)])
        sendNotification.mockRejectedValue(
            Object.assign(new Error('Received unexpected response code'), {
                name: 'WebPushError',
                statusCode: 403,
                endpoint: 'https://fcm.googleapis.com/fcm/send/1',
                headers: { 'x-push-secret': 'header-value' },
                body: 'the body of the push service answer',
            }),
        )

        await pushNotificationSenderService.sendToUser(7n, payload)

        expect(logger.error).toHaveBeenCalledTimes(1)
        const logged = JSON.stringify(vi.mocked(logger.error).mock.calls)
        expect(logged).not.toContain('fcm/send/1')
        expect(logged).not.toContain('header-value')
        expect(logged).not.toContain('the body of the push service answer')
        expect(vi.mocked(logger.error).mock.calls[0]?.[0]).toMatchObject({
            subscriptionId: '1',
            statusCode: 403,
            errorName: 'WebPushError',
        })
    })
})
