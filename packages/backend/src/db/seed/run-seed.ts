import { normalizeEmail } from '#app/services/auth/auth-normalize.js'
import { SEED_PROMPTS } from './prompts.js'
import type { PromptType, SeedPrompt } from './prompts.js'

export type SeedRole = 'user' | 'admin'

export interface SeedUser {
    name: string
    email: string
    passwordHash: string
    role: SeedRole
}

export interface ExistingUser {
    id: bigint
    role: SeedRole
}

// Writes run inside one transaction; the Drizzle implementation lives in drizzle-seed-store.ts.
export interface SeedStore {
    insertPromptIfMissing(prompt: SeedPrompt): Promise<boolean>
    findUserByEmail(normalizedEmail: string): Promise<ExistingUser | undefined>
    insertUser(user: SeedUser): Promise<void>
}

export type SkipReason =
    'already_exists' | 'exists_without_admin_role' | 'missing_credentials' | 'demo_disabled'

export type SeedOutcome = { status: 'inserted' } | { status: 'skipped'; reason: SkipReason }

export interface SeedReport {
    prompts: Record<PromptType, SeedOutcome>
    admin: SeedOutcome
    user: SeedOutcome
}

export interface SeedOptions {
    demo: boolean
    env: Record<string, string | undefined>
    hashPassword: (password: string) => Promise<string>
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

    await store.insertUser({
        name: account.name,
        email,
        passwordHash: await options.hashPassword(password),
        role: account.kind === 'admin' ? 'admin' : 'user',
    })
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
    const admin = await seedAccount(store, adminAccount, options)
    const user = await seedAccount(store, userAccount, options)

    return { prompts, admin, user }
}
