import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-233 (Р11): the push of a new sign-in names its device; the mail goes only to a confirmed
// address, not for a "familiar" device, and within its hourly budget.

vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['FRONTEND_URL'] = 'https://app.example.com'
})

const security = vi.hoisted(() => vi.fn())
const send = vi.hoisted(() => vi.fn())
const findById = vi.hoisted(() => vi.fn())
const findPreferences = vi.hoisted(() => vi.fn())
const consume = vi.hoisted(() => vi.fn())
const listSessions = vi.hoisted(() => vi.fn())
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security },
}))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: { send } }))
vi.mock('#app/repositories/index.js', () => ({
    userRepository: { findById },
    userPreferencesRepository: { findByUserId: findPreferences },
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({ consumeAuthThrottle: consume }))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({ listSessions }))
vi.mock('#vendor/utils/logger.js', () => ({ default: log }))

const { formatSignInTime, mailNewSignIn, notifyNewSignIn, renderNewSignInEmail } =
    await import('./new-sign-in-notice.js')

const CHROME_MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'

const device = (over: Record<string, unknown> = {}) => ({
    publicId: 'n'.repeat(22),
    ip: '203.0.113.7',
    userAgent: CHROME_MAC,
    method: 'password' as const,
    signedInAt: '2026-11-19T12:30:00.000Z',
    ...over,
})

const otherSession = (over: Record<string, unknown> = {}) => ({
    publicId: 'o'.repeat(22),
    sessionId: 'other',
    createdAtMs: 1,
    lastSeenAtMs: 1,
    info: { id: 'other', data: { device: device({ publicId: 'o'.repeat(22), ...over }) } },
})

const user = (over: Record<string, unknown> = {}) => ({
    id: 7n,
    name: 'Jane',
    email: 'jane@example.com',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    sessionToken: 'userToken',
    ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    findById.mockResolvedValue(user())
    findPreferences.mockResolvedValue({ timeZone: 'Europe/Kyiv' })
    consume.mockResolvedValue({ allowed: true, count: 1 })
    listSessions.mockResolvedValue({ sessions: [], next: null })
    send.mockResolvedValue(Result.ok(undefined))
})

describe('the mail rules (Р11)', () => {
    it('a confirmed address and a new device: mailed', async () => {
        expect(await mailNewSignIn(7n, device())).toBe('sent')
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'jane@example.com' }))
        expect(listSessions).toHaveBeenCalledWith('userToken', {
            after: null,
            excludePublicId: 'n'.repeat(22),
        })
    })

    it('an account without an address: no mail', async () => {
        findById.mockResolvedValue(user({ email: null }))
        expect(await mailNewSignIn(7n, device())).toBe('no_address')
        expect(send).not.toHaveBeenCalled()
    })

    it('an unconfirmed address: no mail, it may be somebody else’s', async () => {
        findById.mockResolvedValue(user({ emailVerifiedAt: null }))
        expect(await mailNewSignIn(7n, device())).toBe('unverified')
        expect(send).not.toHaveBeenCalled()
        expect(consume).not.toHaveBeenCalled()
    })

    it('a familiar device (same browser, system and IP in another live session): no mail', async () => {
        listSessions.mockResolvedValue({ sessions: [otherSession()], next: null })
        expect(await mailNewSignIn(7n, device())).toBe('familiar')
        expect(send).not.toHaveBeenCalled()
        expect(consume).not.toHaveBeenCalled()
    })

    it('a familiar device on a later page of the list is found: no mail (feat-234)', async () => {
        const next = { createdAtMs: 5, publicId: 'p'.repeat(22) }
        listSessions
            .mockResolvedValueOnce({ sessions: [otherSession({ ip: '198.51.100.1' })], next })
            .mockResolvedValueOnce({
                sessions: [],
                next: { createdAtMs: 4, publicId: 'q'.repeat(22) },
            })
            .mockResolvedValueOnce({ sessions: [otherSession()], next: null })
        expect(await mailNewSignIn(7n, device())).toBe('familiar')
        expect(listSessions).toHaveBeenCalledTimes(3)
        expect(listSessions).toHaveBeenNthCalledWith(2, 'userToken', {
            after: next,
            excludePublicId: 'n'.repeat(22),
        })
        expect(send).not.toHaveBeenCalled()
    })

    it('no match until the end of the list: mailed', async () => {
        listSessions
            .mockResolvedValueOnce({
                sessions: [otherSession({ ip: '198.51.100.1' })],
                next: { createdAtMs: 5, publicId: 'p'.repeat(22) },
            })
            .mockResolvedValueOnce({ sessions: [], next: null })
        expect(await mailNewSignIn(7n, device())).toBe('sent')
        expect(listSessions).toHaveBeenCalledTimes(2)
    })

    it.each([
        ['another IP', { ip: '198.51.100.1' }],
        ['another browser', { userAgent: FIREFOX_LINUX }],
    ])('not familiar with %s: mailed', async (_, over) => {
        listSessions.mockResolvedValue({ sessions: [otherSession(over)], next: null })
        expect(await mailNewSignIn(7n, device())).toBe('sent')
    })

    it('an unknown User-Agent is never familiar, even on the same IP', async () => {
        listSessions.mockResolvedValue({
            sessions: [otherSession({ userAgent: 'curl/8' })],
            next: null,
        })
        expect(await mailNewSignIn(7n, device({ userAgent: 'curl/8' }))).toBe('sent')
        expect(listSessions).not.toHaveBeenCalled()
    })

    it('over the hourly budget: no mail', async () => {
        consume.mockResolvedValue({ allowed: false, count: 6 })
        expect(await mailNewSignIn(7n, device())).toBe('throttled')
        expect(send).not.toHaveBeenCalled()
    })

    it('a mail service error is an outcome, not an exception', async () => {
        send.mockResolvedValue(Result.err({ _tag: 'EmailSendFailed' }))
        expect(await mailNewSignIn(7n, device())).toBe('failed')
    })
})

describe('notifyNewSignIn', () => {
    it('pushes the device and links the session list; the mail follows its rules', async () => {
        notifyNewSignIn(7n, device(), { mail: true })
        expect(security).toHaveBeenCalledWith(7n, 'new_sign_in', {
            body: 'Signed in from Chrome on macOS. If it was not you, end that session and change your password.',
            url: '/account#sessions',
        })
        await vi.waitFor(() => {
            expect(send).toHaveBeenCalledOnce()
        })
    })

    it('without mail only the push goes (a claim)', async () => {
        notifyNewSignIn(7n, device(), { mail: false })
        expect(security).toHaveBeenCalledOnce()
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(findById).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it('a failure of the mail part is logged and never thrown', async () => {
        findById.mockRejectedValue(new Error('db down'))
        expect(() => {
            notifyNewSignIn(7n, device(), { mail: true })
        }).not.toThrow()
        await vi.waitFor(() => {
            expect(log.warn).toHaveBeenCalledOnce()
        })
    })

    it('an unknown device is named neutrally', () => {
        notifyNewSignIn(7n, device({ userAgent: '' }), { mail: false })
        expect(security).toHaveBeenCalledWith(
            7n,
            'new_sign_in',
            expect.objectContaining({ body: expect.stringContaining('an unknown device') }),
        )
    })
})

describe('the mail', () => {
    it('shows the time in the user’s time zone, or UTC', () => {
        expect(formatSignInTime('2026-11-19T12:30:00.000Z', 'Europe/Kyiv')).toBe(
            '19 Nov 2026, 14:30 (Europe/Kyiv)',
        )
        expect(formatSignInTime('2026-11-19T12:30:00.000Z', null)).toBe('19 Nov 2026, 12:30 (UTC)')
        expect(formatSignInTime('2026-11-19T12:30:00.000Z', 'Mars/Base')).toContain('(UTC)')
    })

    it('is frozen as a file: details, the button to the session list, the warning', async () => {
        const mail = renderNewSignInEmail({
            name: 'Jane',
            device: device({ method: 'oauth', provider: 'github' }),
            timeZone: 'Europe/Kyiv',
        })
        expect(mail.text).toContain('https://app.example.com/account#sessions')
        expect(mail.text).toContain('Signed in with: GitHub')
        await expect(
            [
                '--- subject ---',
                mail.subject,
                '--- text ---',
                mail.text,
                '--- html ---',
                mail.html,
                '',
            ].join('\n'),
        ).toMatchFileSnapshot('./__snapshots__/new-sign-in.txt')
    })
})
