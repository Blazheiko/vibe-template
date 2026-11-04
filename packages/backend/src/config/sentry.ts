import { env } from 'node:process'

import appConfig from '#config/app.js'
import { createEnvReader } from '#vendor/utils/env/env-reader.js'

const reader = createEnvReader()

// feat-113 (R10): a typo here used to warn and silently disable tracing; now startup stops.
export function parseTraceSampleRate(value: string | undefined): {
    value: number
    error: string | null
} {
    if (value === undefined || value.trim() === '') return { value: 0, error: null }

    const text = value.trim()
    // A plain decimal: not '1e-1', '0x1', 'Infinity' (Number() takes all of them)
    const sampleRate = /^\d+(\.\d+)?$|^\.\d+$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
        return {
            value: 0,
            error: `SENTRY_TRACES_SAMPLE_RATE must be a number from 0 to 1, got "${value}"`,
        }
    }
    return { value: sampleRate, error: null }
}

const dsn = env['SENTRY_DSN']
const hasDsn = typeof dsn === 'string' && dsn.trim() !== ''

const sampleRate = parseTraceSampleRate(env['SENTRY_TRACES_SAMPLE_RATE'])
const enabled = reader.bool('SENTRY_ENABLED', true) && hasDsn
const problems = [reader.error, sampleRate.error].filter((problem) => problem !== null)

const config = Object.freeze({
    dsn: hasDsn ? dsn : undefined,
    enabled,
    environment: env['SENTRY_ENVIRONMENT'] ?? appConfig.env,
    release: env['SENTRY_RELEASE'],
    tracesSampleRate: sampleRate.value,
    configError: problems.length > 0 ? problems.join('; ') : null,
})

export default config
