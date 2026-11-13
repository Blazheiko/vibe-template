import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-198 (security review 2026-11-12, M-2): the notice that another provider's identity was
// linked to an account, by push and by mail.
const send = vi.hoisted(() => vi.fn())
const security = vi.hoisted(() => vi.fn())
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: { send } }))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security },
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#config/app.js', () => ({ default: { frontendUrl: 'https://app.example.com' } }))

const { notifySignInMethodAdded, renderSignInMethodAddedEmail } =
    await import('./sign-in-method-notice.js')

const notice = (over: Record<string, unknown> = {}) => ({
    userId: 5n,
    email: 'owner@example.com',
    name: 'Account Owner',
    providerTitle: 'GitHub',
    providerName: 'Jane Doe',
    ...over,
})

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
    vi.clearAllMocks()
    send.mockResolvedValue(Result.ok(undefined))
})

describe('notifySignInMethodAdded', () => {
    it('sends the push and mails the account address', async () => {
        notifySignInMethodAdded(notice())
        await settle()

        expect(security).toHaveBeenCalledWith(5n, 'sign_in_method_added')
        expect(send).toHaveBeenCalledTimes(1)
        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({
                to: 'owner@example.com',
                subject: 'A new sign-in method was added to your account',
            }),
        )
    })

    it.each([null, ''])('mails nothing to an account without an address (%j)', async (email) => {
        notifySignInMethodAdded(notice({ email }))
        await settle()

        expect(security).toHaveBeenCalledWith(5n, 'sign_in_method_added')
        expect(send).not.toHaveBeenCalled()
    })

    it('does not throw or reject when the mail fails; it is logged', async () => {
        send.mockRejectedValue(new Error('smtp down'))

        expect(() => {
            notifySignInMethodAdded(notice())
        }).not.toThrow()
        await settle()

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ userId: '5' }),
            'Sign-in method added: the notice was not mailed',
        )
    })

    it('logs a mail the service refused', async () => {
        send.mockResolvedValue(Result.err({ _tag: 'Internal', publicMessage: 'x' }))

        notifySignInMethodAdded(notice())
        await settle()

        expect(logger.warn).toHaveBeenCalledWith(
            { error: 'Internal', userId: '5' },
            'Sign-in method added: the notice was not mailed',
        )
    })
})

describe('renderSignInMethodAddedEmail', () => {
    it('names the provider and the profile, and says a password change does not remove it', () => {
        const mail = renderSignInMethodAddedEmail(notice())

        expect(mail.subject).toBe('A new sign-in method was added to your account')
        expect(mail.text).toContain('Account Owner')
        expect(mail.text).toContain('The GitHub account "Jane Doe" was linked to your')
        expect(mail.text).toContain(
            'If it was not you, contact support right away: this sign-in method keeps working after a password change.',
        )
        expect(mail.text).toContain('https://app.example.com/support')
        expect(mail.html).toContain('GitHub was linked to your account')
        expect(mail.html).toContain('https://app.example.com/support')
    })

    it.each([
        ['a URL', 'Sign in at https://evil.example/x'],
        ['a bare domain', 'visit evil.example now'],
        ['an address', 'help@evil.example'],
        ['a line break', 'Jane\nYour account is locked'],
        ['no name at all', null],
        ['a blank name', '   '],
    ])('does not quote a profile name with %s', (_, providerName) => {
        const mail = renderSignInMethodAddedEmail(notice({ providerName }))

        expect(mail.text).toContain('A GitHub account was linked to your')
        expect(mail.text).not.toContain('evil.example')
        expect(mail.text).not.toContain('locked')
        expect(mail.html).not.toContain('evil.example')
        expect(mail.html).not.toContain('locked')
    })

    it('escapes what it does quote', () => {
        const mail = renderSignInMethodAddedEmail(notice({ providerName: '<b>Jane & Co' }))

        expect(mail.html).not.toContain('<b>Jane')
        expect(mail.html).toContain('&lt;b&gt;Jane &amp; Co')
    })
})
