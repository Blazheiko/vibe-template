import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import { hashPassword } from 'metautil'
import { env } from 'node:process'
import pg from 'pg'

import appConfig from '../config/app.js'
import { resolveDatabaseConfig, toPgSsl } from '../config/database.js'
import { reportSeedFailure } from './seed/describe-error.js'
import { createDrizzleSeedStore } from './seed/drizzle-seed-store.js'
import { runSeed } from './seed/run-seed.js'
import type { SeedOutcome, SeedReport } from './seed/run-seed.js'

// Reference data (LLM prompts) is always seeded; demo accounts only with --demo.
// The backend caches prompts at startup: run this before starting it, or restart it after.

const describe = (outcome: SeedOutcome): string =>
    outcome.status === 'inserted' ? 'inserted' : `skipped (${outcome.reason})`

function printReport(report: SeedReport): void {
    for (const [type, outcome] of Object.entries(report.prompts)) {
        console.log(`prompt ${type}: ${describe(outcome)}`)
    }
    console.log(`admin: ${describe(report.admin)}`)
    console.log(`user: ${describe(report.user)}`)

    if (report.admin.status === 'skipped' && report.admin.reason === 'exists_without_admin_role') {
        console.warn(
            'WARNING: admin was not created: SEED_ADMIN_EMAIL belongs to an existing non-admin user. ' +
                'The role is not changed automatically.',
        )
    }
}

async function main(): Promise<void> {
    const demo = process.argv.includes('--demo')
    if (demo && appConfig.isProductionLike) {
        console.warn(
            'WARNING: --demo in a production-like environment: demo accounts will be created.',
        )
    }

    const { host, port, user, password, database, ssl } = resolveDatabaseConfig()
    const pool = new pg.Pool({ host, port, user, password, database, ssl: toPgSsl(ssl), max: 1 })
    try {
        const db = drizzle({ client: pool })
        const report = await db.transaction((tx) =>
            runSeed(createDrizzleSeedStore(tx), { demo, env, hashPassword }),
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
