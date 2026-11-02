import { env } from 'node:process'

import { createEnvReader } from '#vendor/utils/env/env-reader.js'

const reader = createEnvReader()

function parseList(value: string | undefined): readonly string[] {
    if (value === undefined || value.trim() === '') {
        return []
    }

    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
}

export const networkConfig = Object.freeze({
    trustProxy: reader.bool('TRUST_PROXY', false),
    trustedProxyCidrs: parseList(env['TRUSTED_PROXY_CIDRS']),
    configError: reader.error,
})
