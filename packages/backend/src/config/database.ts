import { env } from 'node:process'

// Single source of PostgreSQL settings for the app, db:create and drizzle-kit.
// Imported by drizzle.config.ts too, so keep it free of path aliases and app imports.

export interface DatabaseConfig {
    client: string
    host: string
    port: number
    user: string
    password: string
    database: string
    /** Encryption of the connection, see `PGSQL_SSL` and `toPgSsl`. */
    ssl: PgSslMode
}

/** `false`: no TLS; `true`: TLS, the server certificate is verified; `require`: TLS without verification. */
export const PGSQL_SSL_MODES = ['false', 'true', 'require'] as const
export type PgSslMode = (typeof PGSQL_SSL_MODES)[number]

export const DATABASE_DEFAULTS = Object.freeze({
    client: 'pg',
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: '',
    database: 'vibe_template',
    ssl: 'false',
} satisfies DatabaseConfig)

const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value.trim()

const parsePort = (value: string | undefined): number => {
    const raw = nonEmpty(value)
    if (raw === undefined) return DATABASE_DEFAULTS.port
    const port = Number(raw)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`PGSQL_PORT must be an integer from 1 to 65535, got "${raw}"`)
    }
    return port
}

const parseSsl = (value: string | undefined): PgSslMode => {
    const raw = nonEmpty(value)
    if (raw === undefined) return DATABASE_DEFAULTS.ssl
    const mode = raw.toLowerCase()
    if ((PGSQL_SSL_MODES as readonly string[]).includes(mode)) return mode as PgSslMode
    // A typo must not silently fall back to an unencrypted connection.
    throw new Error(`PGSQL_SSL must be one of ${PGSQL_SSL_MODES.join(', ')}, got "${raw}"`)
}

/** The driver option (`pg`'s `ssl`, drizzle-kit's `ssl`) for a mode. */
export const toPgSsl = (mode: PgSslMode): boolean | { rejectUnauthorized: boolean } => {
    if (mode === 'false') return false
    // `require` is libpq's sslmode=require: encrypted, but the certificate is not checked.
    if (mode === 'require') return { rejectUnauthorized: false }
    return true
}

export const resolveDatabaseConfig = (
    source: Record<string, string | undefined> = env,
): DatabaseConfig =>
    Object.freeze({
        client: nonEmpty(source['DB_CONNECTION']) ?? DATABASE_DEFAULTS.client,
        host: nonEmpty(source['PGSQL_HOST']) ?? DATABASE_DEFAULTS.host,
        port: parsePort(source['PGSQL_PORT']),
        user: nonEmpty(source['PGSQL_USER']) ?? DATABASE_DEFAULTS.user,
        password: source['PGSQL_PASSWORD'] ?? DATABASE_DEFAULTS.password,
        database: nonEmpty(source['PGSQL_DB_NAME']) ?? DATABASE_DEFAULTS.database,
        ssl: parseSsl(source['PGSQL_SSL']),
    })

export default resolveDatabaseConfig()
