import { defineConfig } from 'drizzle-kit'

import { resolveDatabaseConfig, toPgSsl } from './src/config/database.ts'

// Relative .ts import: drizzle-kit loads this file itself, without the #config alias.
const dbConfig = resolveDatabaseConfig()

export default defineConfig({
    schema: './src/database/schema.ts',
    out: './src/drizzle/migrations',
    dialect: 'postgresql',
    dbCredentials: {
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        ...(dbConfig.password ? { password: dbConfig.password } : {}),
        database: dbConfig.database,
        ssl: toPgSsl(dbConfig.ssl),
    },
    migrations: {
        table: '__drizzle_migrations',
        schema: 'drizzle',
    },
    verbose: true,
    strict: true,
})
