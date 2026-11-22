import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р14): every change of the second factors is told by
// the notification center and by a mail to the account's address.
const mocks = vi.hoisted(() => ({
    security: vi.fn(),
    send: vi.fn(),
    findById: vi.fn(),
    warn: vi.fn(),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: mocks.security },
}))
vi.mock('#app/services/notifications/email-service.js', () => ({
    emailService: { send: mocks.send },
}))
vi.mock('#app/repositories/index.js', () => ({ userRepository: { findById: mocks.findById } }))
vi.mock('#vendor/utils/logger.js', () => ({ default: { warn: mocks.warn, info: vi.fn() } }))

const { announceMfaChange, renderMfaNoticeEmail } = await import('./mfa-notice.js')
type Kind = Parameters<typeof renderMfaNoticeEmail>[0]

const KINDS: [Kind, string][] = [
    ['enabled', 'mfa_enabled'],
    ['replaced', 'mfa_enabled'],
    ['disabled', 'mfa_disabled'],
    ['recovery_codes_regenerated', 'recovery_codes_regenerated'],
    ['recovery_code_used', 'recovery_code_used'],
    ['passkey_added', 'passkey_added'],
    ['passkey_removed', 'passkey_removed'],
]

beforeEach(() => {
    vi.clearAllMocks()
    mocks.send.mockResolvedValue(Result.ok({ id: 'mail' }))
})

describe('MFA notices (feat-245 Р14)', () => {
    it.each(KINDS)(
        '%s: a notification of its kind and a mail to the address',
        async (kind, event) => {
            mocks.findById.mockResolvedValue({ id: 7n, name: 'Ann', email: 'ann@example.test' })
            announceMfaChange(7n, kind)
            await vi.waitFor(() => {
                expect(mocks.send).toHaveBeenCalledOnce()
            })
            expect(mocks.security).toHaveBeenCalledWith(7n, event)
            const message = mocks.send.mock.calls[0]?.[0] as {
                to: string
                subject: string
                text: string
            }
            expect(message.to).toBe('ann@example.test')
            expect(message.subject).toBe(renderMfaNoticeEmail(kind, 'Ann').subject)
            expect(message.text).toContain('If it was not you')
        },
    )

    it('an account without an address gets the notification only', async () => {
        mocks.findById.mockResolvedValue({ id: 8n, name: 'Phone', email: null })
        announceMfaChange(8n, 'disabled')
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(mocks.security).toHaveBeenCalledWith(8n, 'mfa_disabled')
        expect(mocks.send).not.toHaveBeenCalled()
    })

    it('a failed mail is logged, never thrown', async () => {
        mocks.findById.mockResolvedValue({ id: 9n, name: 'Ann', email: 'ann@example.test' })
        mocks.send.mockResolvedValue(Result.err({ _tag: 'Internal' }))
        announceMfaChange(9n, 'enabled')
        await vi.waitFor(() => {
            expect(mocks.warn).toHaveBeenCalled()
        })
    })
})
