import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SharedProduct from 'shared/product'

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
    lockById: vi.fn(),
}
const passwordResetRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
    burn: vi.fn(),
}
const emailVerificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
    burn: vi.fn(),
}
const emailLinkVerificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
    burn: vi.fn(),
}
const emailServiceMock = { send: vi.fn() }

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    passwordResetRepository: passwordResetRepositoryMock,
    smsAuthChallengeRepository: {},
    emailVerificationRepository: emailVerificationRepositoryMock,
    emailLinkVerificationRepository: emailLinkVerificationRepositoryMock,
    oauthLinkVerificationRepository: {},
    oauthAccountRepository: {},
    pushSubscriptionRepository: {},
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
}))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: emailServiceMock }))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: vi.fn(),
    resetAuthThrottle: vi.fn(),
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: vi.fn(() => Promise.resolve({ deleted: 0, complete: true })),
}))
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
    // No closing tag: a name with a slash is not quoted at all (feat-203), and this one is
    // here to pin the escaping.
    { slug: 'markup', name: `<b>"Jane" & 'Co'` },
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

const SESSION = 'session-7'

function arrange(name: string, over: Record<string, unknown> = {}): void {
    // feat-096: the token is issued on the locked user row.
    userRepositoryMock.lockById.mockResolvedValue({
        id: 7n,
        name,
        email: 'jane@example.com',
        emailVerifiedAt: null,
        sessionToken: SESSION,
        ...over,
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
        // feat-203: the reset mail greets by name only an account whose address is confirmed.
        arrange(name, { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') })
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
        // A link adds an address to an account that has none (a phone-only account).
        arrange(name, { email: null })
        configure()
        const { emailVerificationService } = await import('./email-verification-service.js')
        const result = await emailVerificationService.sendLinkVerificationEmail(
            7n,
            'new@example.com',
            SESSION,
        )
        expect(Result.isOk(result)).toBe(true)
        await expect(render(sentMail())).toMatchFileSnapshot(
            `./__snapshots__/email-link.${slug}.txt`,
        )
    })
})

// feat-203 (security review 2026-11-12, L-1): a mail to an address nobody has confirmed greets
// nobody by name. The name was typed by whoever asked for the mail, and that need not be the
// owner of the mailbox: "your account is locked, sign in at ..." arrived in a mail the product
// signed.
describe('a name is not mailed to an address that is not confirmed', () => {
    const HOSTILE = 'Your account is locked. Call 555 0100 and say your password'
    const expectNoName = (): void => {
        const mail = sentMail()
        expect(mail.text.startsWith('Hello.')).toBe(true)
        expect(mail.text).not.toContain('locked')
        expect(mail.html).not.toContain('locked')
    }

    it('email verification', async () => {
        arrange(HOSTILE)
        configure()
        const { emailVerificationService } = await import('./email-verification-service.js')

        await emailVerificationService.sendVerificationEmail(7n)

        expectNoName()
    })

    it('email linking', async () => {
        arrange(HOSTILE, { email: null })
        configure()
        const { emailVerificationService } = await import('./email-verification-service.js')

        await emailVerificationService.sendLinkVerificationEmail(7n, 'new@example.com', SESSION)

        expectNoName()
    })

    it('password reset of an account whose address is not confirmed', async () => {
        arrange(HOSTILE)
        configure()
        const { passwordResetService } = await import('./password-reset-service.js')

        await passwordResetService.sendPasswordResetEmail(7n)

        expectNoName()
    })

    it('password reset of a confirmed account still greets its owner', async () => {
        arrange('Jane Doe', { emailVerifiedAt: new Date('2026-01-01T00:00:00Z') })
        configure()
        const { passwordResetService } = await import('./password-reset-service.js')

        await passwordResetService.sendPasswordResetEmail(7n)

        expect(sentMail().text.startsWith('Hello, Jane Doe.')).toBe(true)
    })
})

// feat-191: the product name comes from shared/product only. With another name every mail
// carries it in the HTML (escaped) and no trace of the template's own anywhere.
describe('auth mails with another product name', () => {
    const NAME = `Acme <Notes> & Co`
    const send = {
        'password reset': async () => {
            const { passwordResetService } = await import('./password-reset-service.js')
            return passwordResetService.sendPasswordResetEmail(7n)
        },
        'email verification': async () => {
            const { emailVerificationService } = await import('./email-verification-service.js')
            return emailVerificationService.sendVerificationEmail(7n)
        },
        'email linking': async () => {
            const { emailVerificationService } = await import('./email-verification-service.js')
            return emailVerificationService.sendLinkVerificationEmail(
                7n,
                'new@example.com',
                SESSION,
            )
        },
    }

    afterEach(() => {
        vi.doUnmock('shared/product')
    })

    it.each(Object.keys(send) as (keyof typeof send)[])('%s', async (kind) => {
        vi.doMock('shared/product', async (importOriginal) => {
            const actual = await importOriginal<typeof SharedProduct>()
            return { PRODUCT: { ...actual.PRODUCT, name: NAME } }
        })
        arrange('Jane Doe', kind === 'email linking' ? { email: null } : {})
        configure()
        expect(Result.isOk(await send[kind]())).toBe(true)
        const mail = sentMail()
        expect(mail.html).toContain('Acme &lt;Notes&gt; &amp; Co')
        expect(mail.html).not.toContain(NAME)
        expect(render(mail)).not.toMatch(/vibe/i)
    })
})
