import { type } from '@arktype/type'
import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    AdminAuditEventsQuerySchema,
    ListNotificationsQuerySchema,
    ReadAllNotificationsInputSchema,
    SupportChatHistoryQuerySchema,
    UnlinkSignInMethodInputSchema,
} from 'shared/schemas'
import { notFound } from '#app/services/shared/errors.js'

// feat-262 (plan, contract table): every input that carries a row id, with '0', '007' and 2^63.
// Each controller is called with its services mocked, so the test sees what reaches the service
// (or the status the controller answers); a schema row is checked against the schema itself,
// the way the router validates it before the controller runs (a rejection is 422).

const TOO_BIG = '9223372036854775808'
const notFoundResult = () => Result.err(notFound('Thing', 'Not found'))

const mocks = vi.hoisted(() => ({
    listUsers: vi.fn(),
    assign: vi.fn(),
    reset: vi.fn(),
    listHistory: vi.fn(),
    getOnlineUserDetail: vi.fn(),
    listAuditEvents: vi.fn(),
    kbGetById: vi.fn(),
    getScreenshotUrl: vi.fn(),
    getSubscription: vi.fn(),
    renamePasskey: vi.fn(),
    markRead: vi.fn(),
    listNotifications: vi.fn(),
    readAll: vi.fn(),
    unlink: vi.fn(),
    getTextUsage: vi.fn(),
}))

vi.mock('#app/services/admin/admin-user-service.js', () => ({
    adminUserService: { listUsers: mocks.listUsers },
}))
vi.mock('#app/services/user/role-assignment-service.js', () => ({
    roleAssignmentService: { assign: mocks.assign },
}))
vi.mock('#app/services/auth/mfa/mfa-reset-service.js', () => ({
    mfaResetService: { reset: mocks.reset },
}))
vi.mock('#app/services/admin/admin-online-history-service.js', () => ({
    adminOnlineHistoryService: { listHistory: mocks.listHistory },
}))
vi.mock('#app/services/admin/admin-online-users-service.js', () => ({
    adminOnlineUsersService: {
        listOnlineUsers: vi.fn(),
        getOnlineUserDetail: mocks.getOnlineUserDetail,
    },
}))
vi.mock('#app/services/admin/audit-events-query-service.js', () => ({
    auditEventsQueryService: { list: mocks.listAuditEvents },
}))
vi.mock('#app/services/support/knowledge-base-service.js', () => ({
    knowledgeBaseService: { getById: mocks.kbGetById, getScreenshotUrl: mocks.getScreenshotUrl },
}))
vi.mock('#app/services/support/knowledge-base-init-service.js', () => ({
    knowledgeBaseInitService: {},
}))
vi.mock('#app/services/support/support-service.js', () => ({ supportService: {} }))
vi.mock('#app/services/notifications/push-subscription-service.js', () => ({
    pushSubscriptionService: { getSubscription: mocks.getSubscription },
}))
vi.mock('#app/services/notifications/push-notification-sender-service.js', () => ({
    pushNotificationSenderService: {},
}))
vi.mock('#app/services/auth/mfa/passkey-service.js', () => ({
    passkeyService: { rename: mocks.renamePasskey },
}))
vi.mock('#app/services/notifications/notification-center-service.js', () => ({
    notificationCenterService: {
        markRead: mocks.markRead,
        list: mocks.listNotifications,
        readAll: mocks.readAll,
    },
}))
vi.mock('#app/services/auth/sign-in-methods-service.js', () => ({
    signInMethodsService: { unlink: mocks.unlink },
}))
vi.mock('#app/services/ai/usage/llm-usage-service.js', () => ({
    llmUsageService: { getTextUsage: mocks.getTextUsage, getStats: vi.fn() },
}))

const { default: AdminUserController } = await import('./admin/admin-user-controller.js')
const { default: AdminOnlineHistoryController } =
    await import('./admin/admin-online-history-controller.js')
const { default: AdminOnlineUserController } =
    await import('./admin/admin-online-user-controller.js')
const { default: AdminAuditEventsController } =
    await import('./admin/admin-audit-events-controller.js')
const { default: AdminKnowledgeBaseController } =
    await import('./admin/admin-knowledge-base-controller.js')
const { default: SupportController } = await import('./support/support-controller.js')
const { default: PushSubscriptionController } =
    await import('./notifications/push-subscription-controller.js')
const { default: PasskeyController } = await import('./auth/passkey-controller.js')
const { default: NotificationController } =
    await import('./notifications/notification-controller.js')
const { default: SignInMethodsController } = await import('./auth/sign-in-methods-controller.js')
const { default: LlmUsageController } = await import('./ai/usage/llm-usage-controller.js')

interface Input {
    params?: Record<string, string>
    query?: Record<string, unknown>
    payload?: unknown
}

/** A signed-in request (user 7) with the parts a controller reads. */
function contextOf(input: Input) {
    return {
        auth: {
            check: () => true,
            getUserId: () => '7',
            getPresentedUserToken: () => 'token',
        },
        session: { sessionInfo: undefined, isStored: () => Promise.resolve(true) },
        httpData: {
            params: input.params ?? {},
            query: input.query ?? {},
            payload: input.payload ?? null,
        },
        responseData: { status: 200, payload: null, headers: [], cookies: [] },
        requestId: 'req-1',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: new AbortController().signal,
    }
}

/** Runs a handler on a fake context (typed `never`: each handler wants its own context type). */
const call = async (handler: (context: never) => Promise<unknown>, input: Input) => {
    const context = contextOf(input)
    await handler(context as never)
    return context.responseData.status
}

const accepts = (schema: (value: unknown) => unknown, value: unknown) =>
    !(schema(value) instanceof type.errors)

afterEach(() => {
    vi.clearAllMocks()
})

function arrangeServices() {
    const page = { items: [], total: 0, limit: 20, nextCursor: null, hasMore: false }
    mocks.listUsers.mockResolvedValue(page)
    mocks.listHistory.mockResolvedValue(page)
    mocks.assign.mockResolvedValue(notFoundResult())
    mocks.reset.mockResolvedValue(notFoundResult())
    mocks.getOnlineUserDetail.mockResolvedValue(undefined)
    mocks.listAuditEvents.mockResolvedValue(Result.ok({ items: [], nextCursor: null }))
    mocks.kbGetById.mockResolvedValue(notFoundResult())
    mocks.getScreenshotUrl.mockResolvedValue(notFoundResult())
    mocks.getSubscription.mockResolvedValue(notFoundResult())
    mocks.renamePasskey.mockResolvedValue(notFoundResult())
    mocks.markRead.mockResolvedValue(notFoundResult())
    mocks.listNotifications.mockResolvedValue(Result.ok({ items: [], nextCursor: null }))
    mocks.readAll.mockResolvedValue(Result.ok({ updated: 0 }))
    mocks.unlink.mockResolvedValue(notFoundResult())
    mocks.getTextUsage.mockResolvedValue({ rows: [], total: 0 })
}

/** The id the mocked service got as the first field of interest, or `undefined` if not called. */
const firstArg = (fn: ReturnType<typeof vi.fn>, pick: (args: unknown[]) => unknown) =>
    fn.mock.calls.length === 0 ? undefined : pick(fn.mock.calls[0] as unknown[])

describe('feat-262 contract table: controller inputs (now)', () => {
    describe.each([
        {
            name: 'admin users ?userId',
            run: (raw: string) =>
                call((c) => AdminUserController.list(c), { query: { userId: raw, limit: 20 } }),
            got: () => firstArg(mocks.listUsers, (a) => (a[0] as { userId?: bigint }).userId),
        },
        {
            name: 'admin users ?cursor',
            run: (raw: string) =>
                call((c) => AdminUserController.list(c), { query: { cursor: raw, limit: 20 } }),
            got: () => firstArg(mocks.listUsers, (a) => (a[0] as { cursor?: bigint }).cursor),
        },
        {
            name: 'admin users :id (setRole)',
            run: (raw: string) =>
                call((c) => AdminUserController.setRole(c), {
                    params: { id: raw },
                    payload: { role: 'user' },
                }),
            got: () =>
                firstArg(mocks.assign, (a) => (a[0] as { targetUserId: bigint }).targetUserId),
        },
        {
            name: 'admin users :id (resetMfa)',
            run: (raw: string) =>
                call((c) => AdminUserController.resetMfa(c), {
                    params: { id: raw },
                    payload: { reason: 'lost device' },
                }),
            got: () =>
                firstArg(mocks.reset, (a) => (a[0] as { targetUserId: bigint }).targetUserId),
        },
        {
            name: 'online history ?userId',
            run: (raw: string) =>
                call((c) => AdminOnlineHistoryController.list(c), {
                    query: { userId: raw, limit: 20 },
                }),
            got: () => firstArg(mocks.listHistory, (a) => (a[0] as { userId?: bigint }).userId),
        },
        {
            name: 'online history ?cursor',
            run: (raw: string) =>
                call((c) => AdminOnlineHistoryController.list(c), {
                    query: { cursor: raw, limit: 20 },
                }),
            got: () => firstArg(mocks.listHistory, (a) => (a[0] as { cursor?: bigint }).cursor),
        },
        {
            name: 'online user :id',
            run: (raw: string) =>
                call((c) => AdminOnlineUserController.getById(c), { params: { id: raw } }),
            got: () => firstArg(mocks.getOnlineUserDetail, (a) => a[0]),
        },
        {
            name: 'knowledge base :id',
            run: (raw: string) =>
                call((c) => AdminKnowledgeBaseController.getById(c), { params: { id: raw } }),
            got: () => firstArg(mocks.kbGetById, (a) => a[0]),
        },
        {
            name: 'support :articleId',
            run: (raw: string) =>
                call((c) => SupportController.getScreenshot(c), { params: { articleId: raw } }),
            got: () => firstArg(mocks.getScreenshotUrl, (a) => a[0]),
        },
        {
            name: 'push :subscriptionId',
            run: (raw: string) =>
                call((c) => PushSubscriptionController.getSubscription(c), {
                    params: { subscriptionId: raw },
                }),
            got: () => firstArg(mocks.getSubscription, (a) => a[1]),
        },
    ])('$name: parseEntityId', ({ run, got }) => {
        it('passes "0" to the service as 0n', async () => {
            arrangeServices()
            await run('0')
            expect(got()).toBe(0n)
        })

        it('reads "007" as row 7', async () => {
            arrangeServices()
            await run('007')
            expect(got()).toBe(7n)
        })

        it('refuses 2^63 before the service', async () => {
            arrangeServices()
            const status = await run(TOO_BIG)
            expect([400, 404]).toContain(status)
            expect(got()).toBeUndefined()
        })
    })

    describe.each([
        {
            name: 'passkey :id',
            run: (raw: string) =>
                call((c) => PasskeyController.rename(c), {
                    params: { id: raw },
                    payload: { name: 'Key' },
                }),
            got: () => firstArg(mocks.renamePasskey, (a) => a[1]),
        },
        {
            name: 'notification :id',
            run: (raw: string) =>
                call((c) => NotificationController.markRead(c), { params: { id: raw } }),
            got: () => firstArg(mocks.markRead, (a) => a[1]),
        },
    ])('$name: parseEntityId and id > 0n', ({ run, got }) => {
        it('answers "0" with 404 before the service', async () => {
            arrangeServices()
            expect(await run('0')).toBe(404)
            expect(got()).toBeUndefined()
        })

        it('reads "007" as row 7', async () => {
            arrangeServices()
            await run('007')
            expect(got()).toBe(7n)
        })

        it('answers 2^63 with 404 before the service', async () => {
            arrangeServices()
            expect(await run(TOO_BIG)).toBe(404)
            expect(got()).toBeUndefined()
        })
    })

    it('audit events: a 2^63 actor or target the schema let through is 400 invalid_user_id', async () => {
        arrangeServices()
        expect(
            await call((c) => AdminAuditEventsController.list(c), {
                query: { actorUserId: TOO_BIG },
            }),
        ).toBe(400)
        expect(
            await call((c) => AdminAuditEventsController.list(c), {
                query: { targetUserId: TOO_BIG },
            }),
        ).toBe(400)
        expect(mocks.listAuditEvents).not.toHaveBeenCalled()
    })

    it('notifications ?before: 2^63 the schema let through is 400 invalid_cursor', async () => {
        arrangeServices()
        expect(
            await call((c) => NotificationController.list(c), {
                query: { before: TOO_BIG, limit: 20 },
            }),
        ).toBe(400)
        expect(mocks.listNotifications).not.toHaveBeenCalled()
    })

    it('notifications upTo: 2^63 the schema let through is 400 invalid_up_to', async () => {
        arrangeServices()
        expect(
            await call((c) => NotificationController.readAll(c), { payload: { upTo: TOO_BIG } }),
        ).toBe(400)
        expect(mocks.readAll).not.toHaveBeenCalled()
    })

    it('unlink: 2^63 the schema let through reaches the service as a bigint', async () => {
        arrangeServices()
        await call((c) => SignInMethodsController.unlink(c), { payload: { id: TOO_BIG } })
        expect(firstArg(mocks.unlink, (a) => (a[1] as { linkId: bigint }).linkId)).toBe(
            BigInt(TOO_BIG),
        )
    })

    it.each([
        ['abc', undefined],
        ['0x10', 16n],
        ['-5', -5n],
        [' 1', 1n],
        ['  ', undefined],
        ['', undefined],
    ])('llm usage ?userId=%j filters by %s and answers 200', async (raw, expected) => {
        arrangeServices()
        const status = await call((c) => LlmUsageController.getTextUsage(c), {
            query: { page: 1, limit: 10, userId: raw },
        })
        expect(status).toBe(200)
        expect(
            firstArg(
                mocks.getTextUsage,
                (a) => (a[0] as { filter: { userId?: bigint } }).filter.userId,
            ),
        ).toBe(expected)
    })
})

describe('feat-262 contract table: schema inputs (now)', () => {
    it.each(['0', '007'])('audit events ?actorUserId=%j is refused by the schema', (raw) => {
        expect(accepts(AdminAuditEventsQuerySchema, { actorUserId: raw })).toBe(false)
        expect(accepts(AdminAuditEventsQuerySchema, { targetUserId: raw })).toBe(false)
    })

    it('audit events ?actorUserId=2^63 passes the schema', () => {
        expect(accepts(AdminAuditEventsQuerySchema, { actorUserId: TOO_BIG })).toBe(true)
    })

    it.each(['0', '007', TOO_BIG])('support ?before=%j is refused by the schema', (raw) => {
        expect(accepts(SupportChatHistoryQuerySchema, { before: raw })).toBe(false)
    })

    it.each(['0', '007'])('notifications ?before=%j and upTo are refused by the schema', (raw) => {
        expect(accepts(ListNotificationsQuerySchema, { before: raw })).toBe(false)
        expect(accepts(ReadAllNotificationsInputSchema, { upTo: raw })).toBe(false)
    })

    it('notifications ?before and upTo of 2^63 pass the schema', () => {
        expect(accepts(ListNotificationsQuerySchema, { before: TOO_BIG })).toBe(true)
        expect(accepts(ReadAllNotificationsInputSchema, { upTo: TOO_BIG })).toBe(true)
    })

    it.each(['0', '007'])('unlink body id %j is refused by the schema', (raw) => {
        expect(accepts(UnlinkSignInMethodInputSchema, { id: raw })).toBe(false)
    })

    it('unlink body id 2^63 passes the schema', () => {
        expect(accepts(UnlinkSignInMethodInputSchema, { id: TOO_BIG })).toBe(true)
    })
})
