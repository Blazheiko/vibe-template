import { readdirSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { MIGRATIONS_FOLDER, hasPg } from '../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Smoke test of the pg harness: the app's own `db` reaches the throwaway database
// prepared by pg-global-setup.ts, with pgvector and every migration applied.
describe.skipIf(!hasPg)('pg test harness', async () => {
    const { db, pool } = await import('#database/db.js')

    afterAll(async () => {
        await pool.end()
    })

    it('connects to the throwaway test database', async () => {
        const result = await db.execute<{ one: number; name: string }>(
            sql`SELECT 1 AS one, current_database() AS name`,
        )
        expect(result.rows[0]?.one).toBe(1)
        expect(result.rows[0]?.name).toMatch(/^vibe_test_[0-9a-f]{12}$/)
    })

    it('has the vector extension', async () => {
        const result = await db.execute<{ '?column?': number }>(
            sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
        )
        expect(result.rows).toHaveLength(1)
    })

    it('applied every migration folder', async () => {
        const folders = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true }).filter((entry) =>
            entry.isDirectory(),
        )
        const result = await db.execute<{ count: string }>(
            sql`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
        )
        expect(Number(result.rows[0]?.count)).toBe(folders.length)

        const tables = await db.execute<{ '?column?': number }>(
            sql`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'`,
        )
        expect(tables.rows).toHaveLength(1)
    })
})
