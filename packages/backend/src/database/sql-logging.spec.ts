import { describe, expect, it } from 'vitest'

import { sqlLoggingEnabled } from './sql-logging.js'

// Drizzle's logger prints every statement with its parameters: useful while developing, and
// a leak of personal data (emails, tokens in parameters) into the logs of a production-like
// environment.
describe('sqlLoggingEnabled', () => {
    it('is on in development', () => {
        expect(sqlLoggingEnabled({ isProductionLike: false })).toBe(true)
    })

    it('is off in a production-like environment', () => {
        expect(sqlLoggingEnabled({ isProductionLike: true })).toBe(false)
    })
})
