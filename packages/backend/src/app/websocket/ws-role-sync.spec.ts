import type { Role } from 'shared/access'
import type { StaffFactorMode } from 'shared/mfa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MyWebSocket } from '#vendor/types/types.js'

// feat-240 (Р8, T6): one mechanism keeps the role of open connections in step with users.role.

const listConnections = vi.hoisted(() => vi.fn())
const listUserConnections = vi.hoisted(() => vi.fn())
const findRolesByIds = vi.hoisted(() => vi.fn())
const sent = vi.hoisted(
    () => [] as { uuid: string; event: string; payload: unknown; role: unknown }[],
)
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))

vi.mock('#app/websocket/ws-connection-registry.js', () => ({
    wsConnectionRegistry: { listConnections, listUserConnections },
}))
vi.mock('#app/services/user/user-role-service.js', () => ({
    userRoleService: { findRoles: findRolesByIds },
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#config/websocket.js', () => ({ default: { roleRecheckIntervalMs: 30_000 } }))
const mfaConfig = vi.hoisted(() => {
    const config: {
        requiredForStaff: boolean
        staffFactor: StaffFactorMode
        staffFactorMaxAgeHours: number
    } = {
        requiredForStaff: false,
        staffFactor: 'any',
        staffFactorMaxAgeHours: 12,
    }
    return config
})
vi.mock('#config/mfa.js', () => ({ default: mfaConfig }))

interface FakeUserData {
    role: Role | undefined
    isAdminChannelSubscribed: boolean
    adminChannelPaused?: boolean
}
const byUuid = new Map<string, FakeUserData>()
vi.mock('#app/services/communication/broadcast-service.js', () => ({
    broadcastService: {
        broadcastMessageToUserConnection: (
            _userId: string,
            uuid: string,
            event: string,
            payload: unknown,
        ) => {
            // The role the connection holds at the moment it is told.
            sent.push({ uuid, event, payload, role: byUuid.get(uuid)?.role })
            return 1
        },
    },
}))

const { wsRoleSync, ROLE_SYNC_BATCH } = await import('./ws-role-sync.js')

interface FakeConnection {
    userId: string
    uuid: string
    ws: MyWebSocket
    userData: FakeUserData
    subscribe: ReturnType<typeof vi.fn>
    unsubscribe: ReturnType<typeof vi.fn>
}

let connections: FakeConnection[] = []

const connect = (userId: string, uuid: string, role: Role, subscribed = false): FakeConnection => {
    const userData: FakeUserData = { role, isAdminChannelSubscribed: subscribed }
    byUuid.set(uuid, userData)
    const subscribe = vi.fn()
    const unsubscribe = vi.fn()
    const ws = { getUserData: () => userData, subscribe, unsubscribe } as unknown as MyWebSocket
    const connection = { userId, uuid, ws, userData, subscribe, unsubscribe }
    connections.push(connection)
    return connection
}

const rolesInDb = (entries: [string, Role][]): void => {
    findRolesByIds.mockResolvedValue(new Map(entries))
}

beforeEach(() => {
    vi.clearAllMocks()
    connections = []
    byUuid.clear()
    sent.length = 0
    wsRoleSync.reset()
    listConnections.mockImplementation(() => connections)
    listUserConnections.mockImplementation((userId: string) =>
        connections.filter((connection) => connection.userId === userId),
    )
})
afterEach(() => {
    wsRoleSync.stop()
    mfaConfig.requiredForStaff = false
    mfaConfig.staffFactor = 'any'
})

describe('wsRoleSync.refreshUsers', () => {
    it('raises a role on an open connection and tells it after applying', async () => {
        connect('1', 'a', 'user')
        rolesInDb([['1', 'support_operator']])

        const report = await wsRoleSync.refreshUsers(['1'])

        expect(report).toMatchObject({ users: 1, changed: 1, failed: 0 })
        expect(byUuid.get('a')?.role).toBe('support_operator')
        expect(sent).toEqual([
            {
                uuid: 'a',
                event: 'access_changed',
                payload: { role: 'support_operator' },
                role: 'support_operator',
            },
        ])
    })

    it('lowers a role, leaves the admin channel and tells every connection of the user', async () => {
        const first = connect('1', 'a', 'admin', true)
        connect('1', 'b', 'admin')
        rolesInDb([['1', 'kb_editor']])

        await wsRoleSync.refreshUsers(['1'])

        expect(first.unsubscribe).toHaveBeenCalledWith('admin')
        expect(first.userData.isAdminChannelSubscribed).toBe(false)
        expect(sent.map((message) => [message.uuid, message.event, message.role])).toEqual([
            ['a', 'access_changed', 'kb_editor'],
            ['b', 'access_changed', 'kb_editor'],
        ])
    })

    it('tells nothing when the role did not change', async () => {
        connect('1', 'a', 'admin', true)
        rolesInDb([['1', 'admin']])

        expect((await wsRoleSync.refreshUsers(['1'])).changed).toBe(0)
        expect(sent).toEqual([])
    })

    it('gives the role user to a connection whose user no longer exists', async () => {
        connect('1', 'a', 'admin', true)
        rolesInDb([])

        await wsRoleSync.refreshUsers(['1'])

        expect(byUuid.get('a')?.role).toBe('user')
        expect(byUuid.get('a')?.isAdminChannelSubscribed).toBe(false)
    })

    it('drops an older read that finished after a newer one', async () => {
        connect('1', 'a', 'user')
        let answerOld: (roles: Map<string, Role>) => void = () => undefined
        findRolesByIds
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        answerOld = resolve
                    }),
            )
            .mockResolvedValueOnce(new Map([['1', 'kb_editor']]))

        const older = wsRoleSync.refreshUsers(['1'])
        await wsRoleSync.refreshUsers(['1'])
        answerOld(new Map([['1', 'user']]))
        await older

        expect(byUuid.get('a')?.role).toBe('kb_editor')
        expect(sent.map((message) => message.payload)).toEqual([{ role: 'kb_editor' }])
    })

    it('pauses the admin channel on a failed read and never joins it again itself', async () => {
        const admin = connect('1', 'a', 'admin', true)
        const user = connect('2', 'b', 'user')
        findRolesByIds.mockRejectedValueOnce(new Error('database down'))

        const failed = await wsRoleSync.refreshUsers(['1', '2'])

        expect(failed).toMatchObject({ paused: 1, failed: 2 })
        expect(admin.unsubscribe).toHaveBeenCalledWith('admin')
        expect(admin.userData.adminChannelPaused).toBe(true)
        expect(user.userData.adminChannelPaused).toBeUndefined()

        rolesInDb([
            ['1', 'admin'],
            ['2', 'user'],
        ])
        await wsRoleSync.refreshUsers(['1', '2'])

        expect(admin.userData.adminChannelPaused).toBe(false)
        expect(admin.subscribe).not.toHaveBeenCalled()
        expect(sent).toEqual([
            { uuid: 'a', event: 'admin_channel_ready', payload: {}, role: 'admin' },
        ])
    })

    it('sends no admin_channel_ready when the read after a pause took users.read away', async () => {
        const admin = connect('1', 'a', 'admin', true)
        findRolesByIds.mockRejectedValueOnce(new Error('database down'))
        await wsRoleSync.refreshUsers(['1'])
        rolesInDb([['1', 'kb_editor']])

        await wsRoleSync.refreshUsers(['1'])

        expect(admin.userData.adminChannelPaused).toBe(false)
        expect(sent.map((message) => message.event)).toEqual(['access_changed'])
    })

    // Review 2026-11-21: a read covers the connections registered when it started.
    it('leaves a connection registered during the read with the role it read at connect', async () => {
        connect('1', 'a', 'user')
        let answer: (roles: Map<string, Role>) => void = () => undefined
        findRolesByIds.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    answer = resolve
                }),
        )

        const pending = wsRoleSync.refreshUsers(['1'])
        // Registered meanwhile; its own read at connect already saw the new role.
        connect('1', 'b', 'kb_editor')
        answer(new Map([['1', 'user']]))
        await pending

        expect(byUuid.get('a')?.role).toBe('user')
        expect(byUuid.get('b')?.role).toBe('kb_editor')
        expect(sent).toEqual([])
    })

    it('an older read that succeeds after a newer failure does not lift its pause', async () => {
        const admin = connect('1', 'a', 'admin', true)
        let answerOld: (roles: Map<string, Role>) => void = () => undefined
        findRolesByIds
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        answerOld = resolve
                    }),
            )
            .mockRejectedValueOnce(new Error('database down'))

        const older = wsRoleSync.refreshUsers(['1'])
        await wsRoleSync.refreshUsers(['1'])
        expect(admin.userData.adminChannelPaused).toBe(true)

        answerOld(new Map([['1', 'admin']]))
        expect((await older).changed).toBe(0)

        expect(admin.userData.adminChannelPaused).toBe(true)
        expect(sent).toEqual([])
    })

    it('an older read that fails after a newer success pauses nothing', async () => {
        const admin = connect('1', 'a', 'admin', true)
        let failOld: (error: Error) => void = () => undefined
        findRolesByIds
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) => {
                        failOld = reject
                    }),
            )
            .mockResolvedValueOnce(new Map([['1', 'admin']]))

        const older = wsRoleSync.refreshUsers(['1'])
        await wsRoleSync.refreshUsers(['1'])
        failOld(new Error('database down'))
        expect((await older).paused).toBe(0)

        expect(admin.unsubscribe).not.toHaveBeenCalled()
        expect(admin.userData.adminChannelPaused).toBe(false)
    })
})

describe('wsRoleSync.refreshAll', () => {
    it('reads every user with a connection here, in batches', async () => {
        const users = ROLE_SYNC_BATCH + 5
        for (let index = 1; index <= users; index += 1) {
            connect(String(index), `c${String(index)}`, 'user')
        }
        connect('1', 'second-of-1', 'user')
        findRolesByIds.mockImplementation((ids: bigint[]) =>
            Promise.resolve(new Map(ids.map((id) => [String(id), 'user']))),
        )

        const report = await wsRoleSync.refreshAll()

        expect(report.users).toBe(users)
        expect(findRolesByIds).toHaveBeenCalledTimes(2)
        expect((findRolesByIds.mock.calls[0]?.[0] as bigint[]).length).toBe(ROLE_SYNC_BATCH)
        expect((findRolesByIds.mock.calls[1]?.[0] as bigint[]).length).toBe(5)
    })

    it('applies a raise whose signal was lost', async () => {
        connect('1', 'a', 'user')
        rolesInDb([['1', 'user_admin']])

        await wsRoleSync.refreshAll()

        expect(byUuid.get('a')?.role).toBe('user_admin')
        expect(sent.map((message) => message.event)).toEqual(['access_changed'])
    })
})

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): mayUseChannel also needs the staff MFA rule.
describe('wsRoleSync with the staff MFA rule (feat-247)', () => {
    it('a staff connection whose session does not meet the rule leaves the channel and is told once', async () => {
        mfaConfig.requiredForStaff = true
        const admin = connect('1', 'a', 'admin', true)
        Object.assign(admin.userData, { userId: '1', uuid: 'a' })
        rolesInDb([['1', 'admin']])

        await wsRoleSync.refreshUsers(['1'])
        await wsRoleSync.refreshUsers(['1'])

        expect(admin.unsubscribe).toHaveBeenCalledWith('admin')
        expect(admin.userData.isAdminChannelSubscribed).toBe(false)
        expect(sent).toEqual([
            {
                uuid: 'a',
                event: 'access_changed',
                payload: { role: 'admin', reason: 'mfa_session_required' },
                role: 'admin',
            },
        ])
    })

    it('a paused channel is not offered again while the session does not meet the rule', async () => {
        mfaConfig.requiredForStaff = true
        const admin = connect('1', 'a', 'admin')
        Object.assign(admin.userData, { userId: '1', uuid: 'a', adminChannelPaused: true })
        rolesInDb([['1', 'admin']])

        await wsRoleSync.refreshUsers(['1'])

        expect(sent.map(({ event }) => event)).toEqual(['access_changed'])
    })

    it('with the rule off a subscribed staff connection stays', async () => {
        const admin = connect('1', 'a', 'admin', true)
        rolesInDb([['1', 'admin']])

        await wsRoleSync.refreshUsers(['1'])

        expect(admin.unsubscribe).not.toHaveBeenCalled()
        expect(sent).toEqual([])
    })
})

// feat-248 (Р11, Д11): the same pass in both modes: a TOTP sign-in keeps the channel with `any`
// and loses it with `passkey`; a passkey sign-in keeps it in both.
describe('wsRoleSync in both staff factor modes (feat-248)', () => {
    const now = Date.now()
    const iso = (ms: number): string => new Date(ms).toISOString()
    const totpSignIn = {
        v: 1,
        amr: ['pwd', 'otp'],
        aal: 2,
        authenticatedAt: iso(now),
        verified: { pwd: iso(now), otp: iso(now) },
    }
    const passkeySignIn = {
        v: 1,
        amr: ['webauthn'],
        aal: 2,
        authenticatedAt: iso(now),
        verified: { webauthn: iso(now) },
    }

    it.each([
        ['any', 'a TOTP sign-in', totpSignIn, true],
        ['any', 'a passkey sign-in', passkeySignIn, true],
        ['passkey', 'a TOTP sign-in', totpSignIn, false],
        ['passkey', 'a passkey sign-in', passkeySignIn, true],
    ] as const)(
        'MFA_STAFF_FACTOR=%s, %s: keeps the channel = %s',
        async (mode, _name, auth, keeps) => {
            mfaConfig.requiredForStaff = true
            mfaConfig.staffFactor = mode
            const admin = connect('1', 'a', 'admin', true)
            Object.assign(admin.userData, { userId: '1', uuid: 'a', auth })
            rolesInDb([['1', 'admin']])

            await wsRoleSync.refreshUsers(['1'])

            if (keeps) {
                expect(admin.unsubscribe).not.toHaveBeenCalled()
                expect(admin.userData.isAdminChannelSubscribed).toBe(true)
                expect(sent).toEqual([])
            } else {
                expect(admin.unsubscribe).toHaveBeenCalledWith('admin')
                expect(sent.map(({ payload }) => payload)).toEqual([
                    { role: 'admin', reason: 'mfa_session_required' },
                ])
            }
        },
    )
})
