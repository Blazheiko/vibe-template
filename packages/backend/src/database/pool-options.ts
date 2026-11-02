import databaseConfig, { toPgSsl } from '#config/database.js'

// Connection settings shared by every pg.Pool of the app (the main pool and the
// session-check pool), so a change such as SSL applies to all of them at once.
export const connectionOptions = {
    host: databaseConfig.host,
    port: databaseConfig.port,
    user: databaseConfig.user,
    password: databaseConfig.password,
    database: databaseConfig.database,
    idleTimeoutMillis: 30000,
    // PGSQL_SSL: false (default), true (verified TLS) or require (TLS, certificate not checked).
    ssl: toPgSsl(databaseConfig.ssl),
    // The timestamp columns have no time zone. Drizzle writes and reads JS Dates as UTC, so the
    // values the database fills in itself (defaultNow(), now()) must be UTC too, whatever the
    // server's TimeZone is.
    options: '-c TimeZone=UTC',
}
