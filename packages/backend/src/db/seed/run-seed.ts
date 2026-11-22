import { normalizeEmail } from '#app/services/auth/auth-normalize.js'
import type { RecordedAuditEvent } from '#app/services/audit/audit-service.js'
import { base32Decode } from '#app/services/auth/mfa/totp.js'
import type { Role } from 'shared/access'
import { SEED_PROMPTS } from './prompts.js'
import type { PromptType, SeedPrompt } from './prompts.js'

export type SeedRole = 'user' | 'admin'

export interface SeedUser {
    name: string
    email: string
    passwordHash: string
    role: SeedRole
    /** feat-247: a confirmed TOTP factor of this secret, sealed and stored with the user. */
    totpSecret?: Buffer
}

export interface ExistingUser {
    id: bigint
    role: Role
}

// Writes run inside one transaction; the Drizzle implementation lives in drizzle-seed-store.ts.
export interface SeedStore {
    insertPromptIfMissing(prompt: SeedPrompt): Promise<boolean>
    findUserByEmail(normalizedEmail: string): Promise<ExistingUser | undefined>
    /**
     * Inserts the user; for an admin also its `user.admin.created` event, in the same transaction
     * (feat-235), and its TOTP factor when `totpSecret` is given (feat-247). Answers the events
     * written, to be logged once the transaction committed.
     */
    insertUser(user: SeedUser): Promise<RecordedAuditEvent[]>
}

export type SkipReason =
    'already_exists' | 'exists_without_admin_role' | 'missing_credentials' | 'demo_disabled'

export type SeedOutcome = { status: 'inserted' } | { status: 'skipped'; reason: SkipReason }

/**
 * feat-247 (Р10): the TOTP factor of the demo admin, so it meets MFA_REQUIRED_FOR_STAFF from the
 * first sign-in. `env`: SEED_ADMIN_TOTP_SECRET; `generated`: a new secret, development only.
 */
export type AdminTotpOutcome =
    | { status: 'inserted'; secret: Buffer; source: 'env' | 'generated' }
    | { status: 'skipped'; reason: AdminTotpSkipReason }

export type AdminTotpSkipReason =
    /** The admin was not created by this run (no --demo, no credentials, it exists). */
    | 'admin_not_created'
    /** The caller does not seed factors. */
    | 'not_configured'
    /** No SEED_ADMIN_TOTP_SECRET in a production-like environment: no known secret is made. */
    | 'production_like'
    /** No key seals a TOTP secret (MFA_ENCRYPTION_KEYS, or APP_KEY in development). */
    | 'no_mfa_key'

export interface AdminTotpOptions {
    isProductionLike: boolean
    /** A key that seals TOTP secrets is configured. */
    canSeal: boolean
    generateSecret: () => Buffer
}

export interface SeedReport {
    prompts: Record<PromptType, SeedOutcome>
    admin: SeedOutcome
    /** feat-247: the TOTP factor of the admin created by this run. */
    adminTotp: AdminTotpOutcome
    user: SeedOutcome
    /** Written in the seed's transaction; logged after its commit (feat-235, Р12). */
    auditEvents: RecordedAuditEvent[]
}

export interface SeedOptions {
    demo: boolean
    env: Record<string, string | undefined>
    hashPassword: (password: string) => Promise<string>
    /** feat-247: how the demo admin gets its TOTP factor; left out, it gets none. */
    adminTotp?: AdminTotpOptions
}

/** The fewest bytes SEED_ADMIN_TOTP_SECRET may decode to (RFC 4226 asks for 128 bits). */
const MIN_TOTP_SECRET_BYTES = 16

/** SEED_ADMIN_TOTP_SECRET as bytes; a malformed value fails the seed rather than be skipped. */
export function parseSeedTotpSecret(raw: string): Buffer {
    let secret: Buffer
    try {
        secret = base32Decode(raw)
    } catch {
        throw new Error('SEED_ADMIN_TOTP_SECRET must be base32 (A–Z, 2–7)')
    }
    if (secret.length < MIN_TOTP_SECRET_BYTES) {
        throw new Error(
            `SEED_ADMIN_TOTP_SECRET must decode to at least ${String(MIN_TOTP_SECRET_BYTES)} bytes (26 base32 characters)`,
        )
    }
    return secret
}

/** The secret the new demo admin gets, or why it gets none. */
function planAdminTotp(options: SeedOptions): AdminTotpOutcome {
    const totp = options.adminTotp
    if (totp === undefined) return { status: 'skipped', reason: 'not_configured' }
    const raw = nonEmpty(options.env['SEED_ADMIN_TOTP_SECRET'])
    const secret = raw === undefined ? undefined : parseSeedTotpSecret(raw)
    if (secret === undefined && totp.isProductionLike) {
        return { status: 'skipped', reason: 'production_like' }
    }
    if (!totp.canSeal) return { status: 'skipped', reason: 'no_mfa_key' }
    return secret === undefined
        ? { status: 'inserted', secret: totp.generateSecret(), source: 'generated' }
        : { status: 'inserted', secret, source: 'env' }
}

interface DemoAccount {
    kind: 'admin' | 'user'
    name: string
    emailVar: string
    passwordVar: string
}

const DEMO_ACCOUNTS: readonly DemoAccount[] = [
    {
        kind: 'admin',
        name: 'Admin',
        emailVar: 'SEED_ADMIN_EMAIL',
        passwordVar: 'SEED_ADMIN_PASSWORD',
    },
    {
        kind: 'user',
        name: 'Demo User',
        emailVar: 'SEED_USER_EMAIL',
        passwordVar: 'SEED_USER_PASSWORD',
    },
]

const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value

const inserted: SeedOutcome = { status: 'inserted' }
const skipped = (reason: SkipReason): SeedOutcome => ({
    status: 'skipped',
    reason,
})

async function seedAccount(
    store: SeedStore,
    account: DemoAccount,
    options: SeedOptions,
    auditEvents: RecordedAuditEvent[],
    totpSecret?: Buffer,
): Promise<SeedOutcome> {
    if (!options.demo) return skipped('demo_disabled')

    const rawEmail = nonEmpty(options.env[account.emailVar])
    const password = nonEmpty(options.env[account.passwordVar])
    if (rawEmail === undefined || password === undefined) {
        return skipped('missing_credentials')
    }

    const email = normalizeEmail(rawEmail)
    const existing = await store.findUserByEmail(email)
    if (existing !== undefined) {
        // Never touch an existing account: no password reset, no role change.
        return account.kind === 'admin' && existing.role !== 'admin'
            ? skipped('exists_without_admin_role')
            : skipped('already_exists')
    }

    const events = await store.insertUser({
        name: account.name,
        email,
        passwordHash: await options.hashPassword(password),
        role: account.kind === 'admin' ? 'admin' : 'user',
        ...(totpSecret !== undefined ? { totpSecret } : {}),
    })
    auditEvents.push(...events)
    return inserted
}

export async function runSeed(store: SeedStore, options: SeedOptions): Promise<SeedReport> {
    const prompts = {} as Record<PromptType, SeedOutcome>
    for (const prompt of SEED_PROMPTS) {
        prompts[prompt.type] = (await store.insertPromptIfMissing(prompt))
            ? inserted
            : skipped('already_exists')
    }

    const [adminAccount, userAccount] = DEMO_ACCOUNTS as [DemoAccount, DemoAccount]
    const auditEvents: RecordedAuditEvent[] = []
    // Planned before the admin is written: a malformed secret fails the seed with nothing written.
    const plannedTotp: AdminTotpOutcome = options.demo
        ? planAdminTotp(options)
        : { status: 'skipped', reason: 'admin_not_created' }
    const admin = await seedAccount(
        store,
        adminAccount,
        options,
        auditEvents,
        plannedTotp.status === 'inserted' ? plannedTotp.secret : undefined,
    )
    const adminTotp: AdminTotpOutcome =
        admin.status === 'inserted'
            ? plannedTotp
            : { status: 'skipped', reason: 'admin_not_created' }
    const user = await seedAccount(store, userAccount, options, auditEvents)

    return { prompts, admin, adminTotp, user, auditEvents }
}
