import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-199 (decision Д2): a password reset keeps the linked sign-in methods; the reset says
// which, in its answer and in a mail to the account's address.
const send = vi.hoisted(() => vi.fn())
const findByUserId = vi.hoisted(() => vi.fn())
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: { send } }))
vi.mock('#app/repositories/index.js', () => ({ oauthAccountRepository: { findByUserId } }))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#config/app.js', () => ({ default: { frontendUrl: 'https://app.example.com' } }))

const { announcePasswordReset, renderPasswordResetNoticeEmail } =
    await import('./password-reset-notice.js')

const account = (over: Record<string, unknown> = {}) => ({
    userId: 5n,
    email: 'owner@example.com' as string | null,
    name: 'Account Owner',
    ...over,
})
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
    vi.clearAllMocks()
    send.mockResolvedValue(Result.ok(undefined))
    findByUserId.mockResolvedValue([{ provider: 'google' }, { provider: 'github' }])
})

describe('announcePasswordReset', () => {
    it('answers the linked providers, each once, and mails the account address', async () => {
        findByUserId.mockResolvedValue([
            { provider: 'google' },
            { provider: 'github' },
            { provider: 'github' },
        ])

        const providers = await announcePasswordReset(account())
        await settle()

        expect(findByUserId).toHaveBeenCalledWith(5n)
        expect(providers).toEqual(['github', 'google'])
        expect(send).toHaveBeenCalledTimes(1)
        const mail = send.mock.calls[0]?.[0] as { to: string; subject: string; text: string }
        expect(mail.to).toBe('owner@example.com')
        expect(mail.subject).toBe('Your password was reset')
        expect(mail.text).toContain('keep working after a password reset: GitHub, Google.')
    })

    it.each([null, ''])('mails nothing to an account without an address (%j)', async (email) => {
        const providers = await announcePasswordReset(account({ email }))
        await settle()

        expect(providers).toEqual(['github', 'google'])
        expect(send).not.toHaveBeenCalled()
    })

    it('answers an empty list and still mails when the links cannot be read', async () => {
        findByUserId.mockRejectedValue(new Error('db down'))

        const providers = await announcePasswordReset(account())
        await settle()

        expect(providers).toEqual([])
        expect(send).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledTimes(1)
    })

    it('does not reject when the mail fails', async () => {
        send.mockRejectedValue(new Error('smtp down'))

        await expect(announcePasswordReset(account())).resolves.toEqual(['github', 'google'])
        await settle()

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ userId: '5' }),
            'Password reset: the notice was not mailed',
        )
    })
})

describe('renderPasswordResetNoticeEmail', () => {
    it('lists the providers still linked and points to the account page', () => {
        const mail = renderPasswordResetNoticeEmail({
            name: 'Account Owner',
            providers: ['github', 'gitlab'],
        })

        expect(mail.subject).toBe('Your password was reset')
        expect(mail.text).toContain('Account Owner')
        expect(mail.text).toContain('every other session was signed out')
        expect(mail.text).toContain(
            'These sign-in methods are still linked to the account and keep working after a password reset: GitHub, GitLab. If you do not recognise one, sign in and remove it on the account page.',
        )
        expect(mail.text).toContain('https://app.example.com/account')
        expect(mail.html).toContain('GitHub, GitLab')
    })

    it('says nothing about sign-in methods when none is linked', () => {
        const mail = renderPasswordResetNoticeEmail({ name: 'Account Owner', providers: [] })

        expect(mail.text).not.toContain('sign-in methods')
        expect(mail.text).toContain('If it was not you, reset the password again')
    })
})
