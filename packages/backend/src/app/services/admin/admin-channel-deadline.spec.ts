import { Result } from 'better-result'
import { eid } from '../../../test-support/ids.js'
import type { Role } from 'shared/access'
import type { SessionAuthState } from 'shared/mfa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): the admin channel with the staff MFA rule on.
// The broadcast service is the real one; only the uWS publish is replaced. A fake topic records
// which sockets are subscribed at the moment of each publish.

const mfaConfig = vi.hoisted(() => ({
    requiredForStaff: true,
    staffFactor: 'any' as const,
    staffFactorMaxAgeHours: 12,
}))
vi.mock('#config/mfa.js', () => ({ default: mfaConfig }))

const topic = new Set<string>()
const deliveredTo: string[][] = []
const broadcastToChannel = vi.fn((_channel: string, _event: string, _message: string) => {
    deliveredTo.push([...topic].sort())
    return true
})
vi.mock('#vendor/start/server.js', () => ({ broadcastToChannel }))

const sent: { uuid: string; message: string }[] = []
vi.mock('#app/websocket/ws-connection-registry.js', () => ({
    wsConnectionRegistry: {
        getConnection: (_userId: string, uuid: string) => ({
            send: (message: string) => {
                sent.push({ uuid, message })
                return 1
            },
        }),
        forEachConnection: vi.fn(),
    },
}))

const { adminWsChannelService } = await import('./admin-ws-channel-service.js')
const { adminChannelSubscribers } = await import('./admin-channel-subscribers.js')
const { NO_STAFF_DEADLINE } = await import('#app/services/auth/mfa/staff-policy.js')
const { broadcastService } = await import('#app/services/communication/broadcast-service.js')

const T0 = Date.parse('2026-11-22T08:00:00.000Z')
const HOUR = 3_600_000

const aal2 = (verifiedAt: number, extra: Partial<SessionAuthState> = {}): SessionAuthState => ({
    v: 1,
    amr: ['pwd', 'otp'],
    aal: 2,
    authenticatedAt: new Date(verifiedAt).toISOString(),
    verified: { otp: new Date(verifiedAt).toISOString() },
    ...extra,
})

const socket = (uuid: string, auth: SessionAuthState | undefined, role: Role = 'admin') => {
    const userData = {
        uuid,
        userId: '7',
        sessionId: `s-${uuid}`,
        role,
        ...(auth !== undefined ? { auth } : {}),
    } as unknown as UserConnection
    const ws = {
        getUserData: () => userData,
        subscribe: vi.fn(() => topic.add(uuid)),
        unsubscribe: vi.fn(() => topic.delete(uuid)),
    } as unknown as MyWebSocket
    return { ws, userData }
}

const upsert = {
    id: eid(42),
    name: 'Ada',
    email: 'ada@example.test',
    appType: 'web' as const,
    userAgent: 'Mozilla/5.0',
    connectionsCount: 1,
}

const publish = (): boolean =>
    broadcastService.broadcastMessageToChannel('admin', 'admin_user_online_upsert', upsert)

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(T0)
    mfaConfig.requiredForStaff = true
})

afterEach(() => {
    vi.useRealTimers()
    adminChannelSubscribers.reset()
    topic.clear()
    deliveredTo.length = 0
    sent.length = 0
    vi.clearAllMocks()
})

describe('admin channel deadline (feat-247, Р11)', () => {
    it('a publish after the deadline skips the expired socket although its timer has not run', () => {
        const stale = socket('stale', aal2(T0 - 11 * HOUR))
        const fresh = socket('fresh', aal2(T0))
        expect(Result.isOk(adminWsChannelService.subscribeCurrentAdminConnection(stale.ws))).toBe(
            true,
        )
        expect(Result.isOk(adminWsChannelService.subscribeCurrentAdminConnection(fresh.ws))).toBe(
            true,
        )
        expect(stale.userData.staffAccessDeadline).toBe(T0 + HOUR)

        // The clock moves past the deadline; no timer is run (setSystemTime never fires them).
        vi.setSystemTime(T0 + HOUR)
        expect(sent).toEqual([])

        expect(publish()).toBe(true)

        expect(deliveredTo).toEqual([['fresh']])
        expect(topic.has('stale')).toBe(false)
        expect(stale.userData.isAdminChannelSubscribed).toBe(false)
        expect(stale.userData.mfaStale).toBe(true)
        // The timer has still to tell the client.
        expect(sent).toEqual([])
    })

    it('the timer leaves the channel and sends access_changed with the reason', () => {
        const { ws, userData } = socket('a', aal2(T0 - 11 * HOUR))
        adminWsChannelService.subscribeCurrentAdminConnection(ws)

        vi.advanceTimersByTime(HOUR)

        expect(topic.has('a')).toBe(false)
        expect(userData.mfaStale).toBe(true)
        expect(adminWsChannelService.hasSubscribers()).toBe(false)
        expect(sent).toHaveLength(1)
        expect(JSON.parse(sent[0]!.message)).toMatchObject({
            event: 'broadcast:access_changed',
            payload: { role: 'admin', reason: 'mfa_session_required' },
        })
    })

    it('an AAL1 staff socket does not join; a step-up lets it join again with a new deadline', () => {
        const { ws, userData } = socket('a', { ...aal2(T0), aal: 1, amr: ['pwd'], verified: {} })
        const refused = adminWsChannelService.subscribeCurrentAdminConnection(ws)
        expect(Result.isError(refused) && refused.error).toEqual({
            _tag: 'Forbidden',
            message: 'Access denied',
            reason: 'mfa_session_required',
        })
        expect(topic.has('a')).toBe(false)

        // AAL1 stays AAL1 after a step-up (Р2): no channel.
        expect(
            adminWsChannelService.refreshConnectionAuth(ws, {
                ...aal2(T0),
                aal: 1,
                amr: ['pwd'],
            }),
        ).toBe(false)

        // An expired AAL2 socket proves the factor again.
        const expired = socket('b', aal2(T0 - 11 * HOUR))
        adminWsChannelService.subscribeCurrentAdminConnection(expired.ws)
        vi.advanceTimersByTime(HOUR)
        expect(expired.userData.mfaStale).toBe(true)
        expect(adminWsChannelService.refreshConnectionAuth(expired.ws, aal2(T0 + HOUR))).toBe(true)
        expect(expired.userData.mfaStale).toBe(false)
        expect(Result.isOk(adminWsChannelService.subscribeCurrentAdminConnection(expired.ws))).toBe(
            true,
        )
        expect(expired.userData.staffAccessDeadline).toBe(T0 + 13 * HOUR)
        expect(userData.isAdminChannelSubscribed).not.toBe(true)
    })

    it('a step-up of a subscribed socket moves its deadline and its timer', () => {
        const { ws, userData } = socket('a', aal2(T0 - 11 * HOUR))
        adminWsChannelService.subscribeCurrentAdminConnection(ws)

        vi.advanceTimersByTime(HOUR / 2)
        adminWsChannelService.refreshConnectionAuth(ws, aal2(T0 + HOUR / 2))
        expect(userData.staffAccessDeadline).toBe(T0 + HOUR / 2 + 12 * HOUR)

        vi.advanceTimersByTime(HOUR)
        expect(sent).toEqual([])
        expect(topic.has('a')).toBe(true)
        vi.setSystemTime(T0 + 13 * HOUR)
        publish()
        expect(deliveredTo.at(-1)).toEqual([])
    })

    it('a recovery session or a stale proof does not join', () => {
        const recovery = socket('r', {
            ...aal2(T0),
            recovery: {
                startedAt: new Date(T0).toISOString(),
                expiresAt: new Date(T0 + HOUR).toISOString(),
            },
        })
        const old = socket('o', aal2(T0 - 13 * HOUR))
        expect(
            Result.isError(adminWsChannelService.subscribeCurrentAdminConnection(recovery.ws)),
        ).toBe(true)
        expect(Result.isError(adminWsChannelService.subscribeCurrentAdminConnection(old.ws))).toBe(
            true,
        )
    })

    it('closing clears the timer', () => {
        const { ws } = socket('a', aal2(T0 - 11 * HOUR))
        adminWsChannelService.subscribeCurrentAdminConnection(ws)
        adminWsChannelService.handleConnectionClosed(ws)
        vi.advanceTimersByTime(2 * HOUR)
        expect(sent).toEqual([])
        expect(adminWsChannelService.hasSubscribers()).toBe(false)
    })

    it('with the rule off nothing expires and no timer is set', () => {
        mfaConfig.requiredForStaff = false
        const { ws, userData } = socket('a', undefined)
        expect(Result.isOk(adminWsChannelService.subscribeCurrentAdminConnection(ws))).toBe(true)
        // feat-273: never is no number: the vendor field stays absent, the registry names it.
        expect(userData.staffAccessDeadline).toBeUndefined()
        expect(adminChannelSubscribers.deadlineOf(ws)).toBe(NO_STAFF_DEADLINE)
        expect(vi.getTimerCount()).toBe(0)
        vi.setSystemTime(T0 + 1000 * HOUR)
        publish()
        expect(deliveredTo).toEqual([['a']])
    })
})
