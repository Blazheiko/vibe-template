import { describe, expect, it } from 'vitest'

import { DATABASE_DEFAULTS, resolveDatabaseConfig, toPgSsl } from './database.js'

describe('resolveDatabaseConfig', () => {
    it('falls back to defaults when nothing is set', () => {
        expect(resolveDatabaseConfig({})).toEqual(DATABASE_DEFAULTS)
    })

    it('treats empty values as unset', () => {
        expect(resolveDatabaseConfig({ PGSQL_PORT: '', PGSQL_HOST: ' ' })).toMatchObject({
            host: '127.0.0.1',
            port: 5432,
        })
    })

    it('reads PGSQL_* values', () => {
        expect(
            resolveDatabaseConfig({
                PGSQL_HOST: 'db',
                PGSQL_PORT: '6543',
                PGSQL_USER: 'app',
                PGSQL_PASSWORD: 'secret',
                PGSQL_DB_NAME: 'app_db',
            }),
        ).toEqual({
            client: 'pg',
            host: 'db',
            port: 6543,
            user: 'app',
            password: 'secret',
            database: 'app_db',
            ssl: 'false',
        })
    })

    it.each(['abc', '0', '70000', '54.3'])('rejects PGSQL_PORT=%s', (port) => {
        expect(() => resolveDatabaseConfig({ PGSQL_PORT: port })).toThrow(/PGSQL_PORT/)
    })
})

// F3 (feat-067): the connection to PostgreSQL had `ssl: false` written into the code, with no
// way to turn encryption on for a managed database.
describe('PGSQL_SSL', () => {
    it('is off by default', () => {
        expect(resolveDatabaseConfig({}).ssl).toBe('false')
        expect(DATABASE_DEFAULTS.ssl).toBe('false')
    })

    it.each(['false', 'true', 'require'])('accepts %s', (mode) => {
        expect(resolveDatabaseConfig({ PGSQL_SSL: mode }).ssl).toBe(mode)
    })

    it('ignores case and surrounding spaces, and treats an empty value as unset', () => {
        expect(resolveDatabaseConfig({ PGSQL_SSL: ' TRUE ' }).ssl).toBe('true')
        expect(resolveDatabaseConfig({ PGSQL_SSL: '' }).ssl).toBe('false')
    })

    it.each(['yes', '1', 'verify-full', 'disable', 'tru'])(
        'rejects %s instead of guessing',
        (mode) => {
            expect(() => resolveDatabaseConfig({ PGSQL_SSL: mode })).toThrow(
                /PGSQL_SSL must be one of/,
            )
        },
    )

    it('maps to the driver option: off, verified TLS, TLS without verification', () => {
        expect(toPgSsl('false')).toBe(false)
        expect(toPgSsl('true')).toBe(true)
        expect(toPgSsl('require')).toEqual({ rejectUnauthorized: false })
    })
})
