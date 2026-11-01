import { afterEach, describe, expect, it, vi } from 'vitest'

// The one place the connection settings of every pool come from (the main pool and the
// session-check pool): PGSQL_SSL has to reach them both.

afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
})

const load = async () => (await import('./pool-options.js')).connectionOptions

describe('connectionOptions', () => {
    it('is unencrypted by default', async () => {
        vi.stubEnv('PGSQL_SSL', '')
        expect((await load()).ssl).toBe(false)
    })

    it('verifies the server certificate for PGSQL_SSL=true', async () => {
        vi.stubEnv('PGSQL_SSL', 'true')
        expect((await load()).ssl).toBe(true)
    })

    it('encrypts without verifying the certificate for PGSQL_SSL=require', async () => {
        vi.stubEnv('PGSQL_SSL', 'require')
        expect((await load()).ssl).toEqual({ rejectUnauthorized: false })
    })
})
