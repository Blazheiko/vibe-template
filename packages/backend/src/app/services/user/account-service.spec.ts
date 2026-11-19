import { Result } from 'better-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-232: the account service with the repositories, the transaction and the throttle mocked.
// The PG suites (account-preferences.pg.test.ts, account-service.pg.test.ts) cover the SQL.

const TX = { tx: true }
const userRepositoryMock = {
    findById: vi.fn(),
    updateNameIfSessionToken: vi.fn(),
    shareIfSessionToken: vi.fn(),
}
const userPreferencesRepositoryMock = {
    findByUserId: vi.fn(),
    applyPatch: vi.fn(),
}
const withTransactionMock = vi.fn((work: (tx: unknown) => Promise<unknown>) => work(TX))
const enforceThrottleMock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    userPreferencesRepository: userPreferencesRepositoryMock,
    withTransaction: withTransactionMock,
}))
vi.mock('#app/services/auth/enforce-throttle.js', () => ({
    enforceThrottle: enforceThrottleMock,
}))
const publishToUserMock = vi.fn((..._args: unknown[]) => Promise.resolve())
vi.mock('#app/services/communication/user-event-bus.js', () => ({
    userEventBus: { publishToUser: publishToUserMock },
}))

const { accountService } = await import('./account-service.js')

const TOKEN = 'presented-token'
const stored = () => Promise.resolve(true)

const row = (fields: Record<string, unknown> = {}) => ({
    userId: 7n,
    locale: null,
    timeZone: null,
    theme: null,
    colorTheme: null,
    fontSize: null,
    revision: 1n,
    updatedAt: new Date('2026-11-19T00:00:00Z'),
    ...fields,
})

const errorOf = (result: Awaited<ReturnType<typeof accountService.updateProfile>>) => {
    if (!Result.isError(result)) throw new Error('expected an error')
    return result.error
}

beforeEach(() => {
    enforceThrottleMock.mockResolvedValue(Result.ok(undefined))
    userRepositoryMock.shareIfSessionToken.mockResolvedValue({ name: 'Ann' })
    userRepositoryMock.updateNameIfSessionToken.mockImplementation(
        (_id: bigint, _token: string, name: string) => Promise.resolve({ name }),
    )
    userPreferencesRepositoryMock.applyPatch.mockImplementation(
        (_id: bigint, patch: Record<string, unknown>) => Promise.resolve(row(patch)),
    )
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('accountService.getProfile', () => {
    it('a user without a preferences row: every preference null, revision "0"', async () => {
        userRepositoryMock.findById.mockResolvedValue({ id: 7n, name: 'Ann' })
        userPreferencesRepositoryMock.findByUserId.mockResolvedValue(undefined)

        const result = await accountService.getProfile(7n)

        expect(result).toEqual(
            Result.ok({
                name: 'Ann',
                preferences: {
                    locale: null,
                    timeZone: null,
                    theme: null,
                    colorTheme: null,
                    fontSize: null,
                },
                revision: '0',
            }),
        )
    })

    it('reads a stored zone the runtime no longer knows as null', async () => {
        userRepositoryMock.findById.mockResolvedValue({ id: 7n, name: 'Ann' })
        userPreferencesRepositoryMock.findByUserId.mockResolvedValue(
            row({ timeZone: 'Mars/Base', theme: 'dark', revision: 42n }),
        )

        const result = await accountService.getProfile(7n)

        if (!Result.isOk(result)) throw new Error('expected ok')
        expect(result.value.preferences.timeZone).toBeNull()
        expect(result.value.preferences.theme).toBe('dark')
        expect(result.value.revision).toBe('42')
    })

    it('a missing user is not found', async () => {
        userRepositoryMock.findById.mockResolvedValue(undefined)
        userPreferencesRepositoryMock.findByUserId.mockResolvedValue(undefined)

        const result = await accountService.getProfile(7n)

        expect(Result.isError(result)).toBe(true)
    })
})

describe('accountService.updateProfile', () => {
    it('writes only the passed fields; null is passed on as a reset', async () => {
        const result = await accountService.updateProfile(
            7n,
            { theme: null, fontSize: 18 },
            TOKEN,
            stored,
        )

        expect(userPreferencesRepositoryMock.applyPatch).toHaveBeenCalledWith(
            7n,
            { theme: null, fontSize: 18 },
            TX,
        )
        const patch = userPreferencesRepositoryMock.applyPatch.mock.calls[0]![1] as object
        expect(Object.keys(patch).sort()).toEqual(['fontSize', 'theme'])
        expect(userRepositoryMock.shareIfSessionToken).toHaveBeenCalledWith(7n, TOKEN, TX)
        expect(userRepositoryMock.updateNameIfSessionToken).not.toHaveBeenCalled()
        if (!Result.isOk(result)) throw new Error('expected ok')
        expect(result.value.preferences.fontSize).toBe(18)
        expect(result.value.revision).toBe('1')
        expect(typeof result.value.revision).toBe('string')
    })

    it('after the commit, the new profile goes to every connection of the user (Р9 B)', async () => {
        const result = await accountService.updateProfile(7n, { theme: 'dark' }, TOKEN, stored)

        if (!Result.isOk(result)) throw new Error('expected ok')
        expect(publishToUserMock).toHaveBeenCalledExactlyOnceWith(
            '7',
            'user_profile_updated',
            result.value,
        )
    })

    it('a failed event does not fail the change', async () => {
        publishToUserMock.mockRejectedValueOnce(new Error('bus down'))

        const result = await accountService.updateProfile(7n, { theme: 'dark' }, TOKEN, stored)

        expect(Result.isOk(result)).toBe(true)
    })

    it('a refused change sends no event', async () => {
        userRepositoryMock.shareIfSessionToken.mockResolvedValue(undefined)
        userRepositoryMock.findById.mockResolvedValue({ id: 7n, name: 'Ann' })
        await accountService.updateProfile(7n, { theme: 'dark' }, TOKEN, stored)
        await accountService.updateProfile(7n, { timeZone: 'Mars/Base' }, TOKEN, stored)

        expect(publishToUserMock).not.toHaveBeenCalled()
    })

    it('a change of the name only still upserts the preferences with an empty patch', async () => {
        const result = await accountService.updateProfile(7n, { name: 'Bob' }, TOKEN, stored)

        expect(userRepositoryMock.updateNameIfSessionToken).toHaveBeenCalledWith(
            7n,
            TOKEN,
            'Bob',
            TX,
        )
        expect(userPreferencesRepositoryMock.applyPatch).toHaveBeenCalledWith(7n, {}, TX)
        if (!Result.isOk(result)) throw new Error('expected ok')
        expect(result.value.name).toBe('Bob')
    })

    it('the name and the preferences get the same transaction', async () => {
        await accountService.updateProfile(7n, { name: 'Bob', locale: 'uk' }, TOKEN, stored)

        expect(withTransactionMock).toHaveBeenCalledOnce()
        expect(userRepositoryMock.updateNameIfSessionToken.mock.calls[0]![3]).toBe(TX)
        expect(userPreferencesRepositoryMock.applyPatch.mock.calls[0]![2]).toBe(TX)
    })

    it('an unknown time zone is a bad request with no throttle spent and no write', async () => {
        const result = await accountService.updateProfile(
            7n,
            { timeZone: 'Mars/Base' },
            TOKEN,
            stored,
        )

        expect(errorOf(result)).toMatchObject({ _tag: 'BadRequest' })
        expect(enforceThrottleMock).not.toHaveBeenCalled()
        expect(withTransactionMock).not.toHaveBeenCalled()
    })

    it('UTC and a reset of the zone are accepted', async () => {
        for (const timeZone of ['UTC', null, 'Europe/Kyiv']) {
            const result = await accountService.updateProfile(7n, { timeZone }, TOKEN, stored)
            expect(Result.isOk(result), String(timeZone)).toBe(true)
        }
    })

    it('a spent budget is a rate limit with no write', async () => {
        enforceThrottleMock.mockResolvedValue(Result.err({ _tag: 'RateLimited', message: 'x' }))

        const result = await accountService.updateProfile(7n, { theme: 'dark' }, TOKEN, stored)

        expect(errorOf(result)).toMatchObject({ _tag: 'RateLimited' })
        expect(withTransactionMock).not.toHaveBeenCalled()
    })

    it('a session record deleted by a logout in another tab: 401 with no write', async () => {
        const result = await accountService.updateProfile(7n, { theme: 'dark' }, TOKEN, () =>
            Promise.resolve(false),
        )

        expect(errorOf(result)).toMatchObject({ _tag: 'Unauthorized' })
        expect(withTransactionMock).not.toHaveBeenCalled()
    })

    it('a rotated session token: 401 and the preferences are not written', async () => {
        userRepositoryMock.shareIfSessionToken.mockResolvedValue(undefined)
        userRepositoryMock.findById.mockResolvedValue({ id: 7n, name: 'Ann' })

        const result = await accountService.updateProfile(7n, { theme: 'dark' }, TOKEN, stored)

        expect(errorOf(result)).toMatchObject({ _tag: 'Unauthorized' })
        expect(userPreferencesRepositoryMock.applyPatch).not.toHaveBeenCalled()
    })

    it('no presented token: 401 with no write', async () => {
        const result = await accountService.updateProfile(7n, { theme: 'dark' }, undefined, stored)

        expect(errorOf(result)).toMatchObject({ _tag: 'Unauthorized' })
        expect(withTransactionMock).not.toHaveBeenCalled()
    })
})
