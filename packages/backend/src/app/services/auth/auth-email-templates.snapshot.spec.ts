import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'

// feat-069 (G1): the three auth mails — password reset, email verification and email linking —
// are frozen as files before they are moved into one shared template module (H3). The
// refactor must not change a character of subject, text or html: the files in `__snapshots__/`
// are the expectation, and they are reviewed as HTML, not as a diff of a template literal.
//
// The token in the link is random, so it is replaced by a placeholder; everything else is the
// bytes the user would receive. The second user has a name with markup in it, which pins the
// escaping.

const userRepositoryMock = {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    update: vi.fn(),
}
const passwordResetRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
}
const emailVerificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
}
const emailLinkVerificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
}
const emailServiceMock = { send: vi.fn() }

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    passwordResetRepository: passwordResetRepositoryMock,
    smsAuthChallengeRepository: {},
    emailVerificationRepository: emailVerificationRepositoryMock,
    emailLinkVerificationRepository: emailLinkVerificationRepositoryMock,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
}))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: emailServiceMock }))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: vi.fn(),
    resetAuthThrottle: vi.fn(),
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({ destroyAllSessions: vi.fn() }))
vi.mock('#app/services/auth/sms-verification-provider.js', () => ({
    smsVerificationProvider: { issueVerificationCode: vi.fn() },
}))
vi.mock('metautil', () => ({ hashPassword: vi.fn() }))
vi.mock('#logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const originalEnv = { ...process.env }

afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
})

const USERS = [
    { slug: 'plain', name: 'Jane Doe' },
    { slug: 'markup', name: `<b>"Jane" & 'Co'</b>` },
    { slug: 'blank', name: '   ' },
] as const

interface SentMail {
    to: string
    subject: string
    text: string
    html: string
}

function render(mail: SentMail): string {
    const mask = (value: string): string => value.replaceAll(/token=[\w-]+/g, 'token=<TOKEN>')
    return [
        `to: ${mail.to}`,
        `subject: ${mail.subject}`,
        '--- text ---',
        mask(mail.text),
        '--- html ---',
        mask(mail.html),
        '',
    ].join('\n')
}

function sentMail(): SentMail {
    expect(emailServiceMock.send).toHaveBeenCalledTimes(1)
    return emailServiceMock.send.mock.calls[0]![0] as SentMail
}

function configure(): void {
    process.env['FRONTEND_URL'] = 'https://app.example.com'
    process.env['APP_URL'] = 'https://app.example.com'
    process.env['APP_KEY'] = 'a'.repeat(32)
}

function arrange(name: string): void {
    userRepositoryMock.findById.mockResolvedValue({
        id: 7n,
        name,
        email: 'jane@example.com',
        emailVerifiedAt: null,
    })
    for (const repo of [
        passwordResetRepositoryMock,
        emailVerificationRepositoryMock,
        emailLinkVerificationRepositoryMock,
    ]) {
        repo.invalidatePendingByUserId.mockResolvedValue(undefined)
        repo.create.mockResolvedValue({ id: 1n })
    }
    emailServiceMock.send.mockResolvedValue(Result.ok(undefined))
}

describe.each(USERS)('auth mails for a user named $slug', ({ slug, name }) => {
    it('password reset', async () => {
        arrange(name)
        configure()
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = await passwordResetService.sendPasswordResetEmail(7n)
        expect(Result.isOk(result)).toBe(true)
        await expect(render(sentMail())).toMatchFileSnapshot(
            `./__snapshots__/password-reset.${slug}.txt`,
        )
    })

    it('email verification', async () => {
        arrange(name)
        configure()
        const { emailVerificationService } = await import('./email-verification-service.js')
        const result = await emailVerificationService.sendVerificationEmail(7n)
        expect(Result.isOk(result)).toBe(true)
        await expect(render(sentMail())).toMatchFileSnapshot(
            `./__snapshots__/email-verification.${slug}.txt`,
        )
    })

    it('email linking', async () => {
        arrange(name)
        configure()
        const { emailVerificationService } = await import('./email-verification-service.js')
        const result = await emailVerificationService.sendLinkVerificationEmail(
            7n,
            'new@example.com',
        )
        expect(Result.isOk(result)).toBe(true)
        await expect(render(sentMail())).toMatchFileSnapshot(
            `./__snapshots__/email-link.${slug}.txt`,
        )
    })
})
