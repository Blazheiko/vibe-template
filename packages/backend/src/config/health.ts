import { env } from 'node:process'

import { parseInteger } from '#vendor/utils/env/read-int.js'

// Per-dependency timeout of GET /ready (code-issues item 35).
const readTimeout = (): { readinessTimeoutMs: number; configError: string | null } => {
    const { value, error } = parseInteger(
        'READINESS_CHECK_TIMEOUT_MS',
        env['READINESS_CHECK_TIMEOUT_MS'],
        1000,
        { min: 50, max: 30_000 },
    )
    return { readinessTimeoutMs: value, configError: error }
}

export default Object.freeze(readTimeout())
