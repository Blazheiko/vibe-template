import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import { hashPassword } from 'metautil'
import { env } from 'node:process'
import pg from 'pg'
import { PRODUCT } from 'shared/product'

import appConfig from '../config/app.js'
import { resolveDatabaseConfig, toPgSsl } from '../config/database.js'
import { mfaSecretBox } from '../app/services/auth/mfa/mfa-secret-box.js'
import { base32Encode, generateTotpSecret, otpauthUri } from '../app/services/auth/mfa/totp.js'
import { reportSeedFailure } from './seed/describe-error.js'
import { createDrizzleSeedStore } from './seed/drizzle-seed-store.js'
import { runSeed } from './seed/run-seed.js'
import { seedCommitted } from './seed/seed-transaction.js'
import logger from '#logger'
import type { AdminTotpOutcome, SeedOutcome, SeedReport } from './seed/run-seed.js'

// Reference data (LLM prompts) is always seeded; demo accounts only with --demo.
// The backend caches prompts at startup: run this before starting it, or restart it after.

const describe = (outcome: SeedOutcome): string =>
    outcome.status === 'inserted' ? 'inserted' : `skipped (${outcome.reason})`

function printReport(report: SeedReport): void {
    for (const [type, outcome] of Object.entries(report.prompts)) {
        console.log(`prompt ${type}: ${describe(outcome)}`)
    }
    console.log(`admin: ${describe(report.admin)}`)
    printAdminTotp(report.adminTotp, env['SEED_ADMIN_EMAIL']?.trim() ?? 'admin')
    console.log(`user: ${describe(report.user)}`)

    if (report.admin.status === 'skipped' && report.admin.reason === 'exists_without_admin_role') {
        console.warn(
            'WARNING: admin was not created: SEED_ADMIN_EMAIL belongs to an existing non-admin user. ' +
                'The role is not changed automatically.',
        )
    }
}

/**
 * feat-247 (Р10): the demo admin meets MFA_REQUIRED_FOR_STAFF from its first sign-in with a TOTP
 * factor. Outside a production-like environment its secret is printed, to be added to an
 * authenticator app; in one the operator's own SEED_ADMIN_TOTP_SECRET is never echoed.
 */
function printAdminTotp(outcome: AdminTotpOutcome, account: string): void {
    if (outcome.status === 'skipped') {
        if (outcome.reason === 'admin_not_created' || outcome.reason === 'not_configured') return
        console.log(`admin TOTP: skipped (${outcome.reason})`)
        console.warn(
            'WARNING: the admin has no second factor. Until it sets one up (account -> security, ' +
                'after signing in with the password) the admin area answers 403 mfa_required. ' +
                (outcome.reason === 'production_like'
                    ? 'Set SEED_ADMIN_TOTP_SECRET to seed a factor of a secret you hold.'
                    : 'Configure MFA_ENCRYPTION_KEYS (or APP_KEY) to seed one.'),
        )
        return
    }
    const source = outcome.source === 'env' ? 'from SEED_ADMIN_TOTP_SECRET' : 'generated'
    console.log(`admin TOTP: inserted (${source})`)
    if (appConfig.isProductionLike) return
    console.log(`  secret:  ${base32Encode(outcome.secret)}`)
    console.log(`  otpauth: ${otpauthUri(outcome.secret, PRODUCT.name, account)}`)
}

async function main(): Promise<void> {
    const demo = process.argv.includes('--demo')
    if (demo && appConfig.isProductionLike) {
        console.warn(
            'WARNING: --demo in a production-like environment: demo accounts will be created.',
        )
    }

    const { host, port, user, password, database, ssl } = resolveDatabaseConfig()
    // TimeZone=UTC as in database/pool-options.ts: rows get their created_at from defaultNow().
    const pool = new pg.Pool({
        host,
        port,
        user,
        password,
        database,
        ssl: toPgSsl(ssl),
        max: 1,
        options: '-c TimeZone=UTC',
    })
    try {
        const db = drizzle({ client: pool })
        type SeedTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
        const report = await seedCommitted<SeedTx>(
            (work) => db.transaction((tx) => work(tx)),
            (tx) =>
                runSeed(createDrizzleSeedStore(tx), {
                    demo,
                    env,
                    hashPassword,
                    adminTotp: {
                        isProductionLike: appConfig.isProductionLike,
                        canSeal: mfaSecretBox() !== null,
                        generateSecret: generateTotpSecret,
                    },
                }),
            logger,
        )
        printReport(report)
    } finally {
        await pool.end()
    }
}

main().catch((err: unknown) => {
    reportSeedFailure(err)
    process.exitCode = 1
})
