import databaseConfig from '#config/database.js'

// Connection settings shared by every pg.Pool of the app (the main pool and the
// session-check pool), so a change such as SSL applies to all of them at once.
export const connectionOptions = {
    host: databaseConfig.host,
    port: databaseConfig.port,
    user: databaseConfig.user,
    password: databaseConfig.password,
    database: databaseConfig.database,
    idleTimeoutMillis: 30000,
    ssl: false,
} as const
