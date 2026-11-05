import { env as processEnv } from 'node:process'

import { createEnvReader } from '#vendor/utils/env/env-reader.js'
import { isValidCidrEntry } from '#vendor/utils/network/ip-address.js'

function parseList(value: string | undefined): readonly string[] {
    if (value === undefined || value.trim() === '') {
        return []
    }

    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
}

export interface NetworkConfig {
    trustProxy: boolean
    trustedProxyCidrs: readonly string[]
    /**
     * With APP_UNIX_PATH: the unix socket belongs to the reverse proxy, so the client IP is read
     * from its X-Forwarded-For / X-Real-IP (feat-110). Without it every client is `unknown`.
     */
    trustUnixSocketProxy: boolean
    configError: string | null
}

export function readNetworkConfig(env: NodeJS.ProcessEnv = processEnv): NetworkConfig {
    const reader = createEnvReader(env)
    const trustedProxyCidrs = parseList(env['TRUSTED_PROXY_CIDRS'])
    // feat-132 (P2): an entry that is neither an address nor a CIDR stops the start. A prefix
    // typo (`10.0.0.0/`) used to read as /0 and trust every client.
    const invalid = trustedProxyCidrs.filter((entry) => !isValidCidrEntry(entry))
    const cidrError =
        invalid.length === 0
            ? null
            : `TRUSTED_PROXY_CIDRS has entries that are not an address or a CIDR: ${invalid
                  .map((entry) => JSON.stringify(entry))
                  .join(', ')}`
    const config = {
        trustProxy: reader.bool('TRUST_PROXY', false),
        trustedProxyCidrs,
        trustUnixSocketProxy: reader.bool('TRUST_UNIX_SOCKET_PROXY', false),
    }
    const problems = [reader.error, cidrError].filter(
        (problem): problem is string => problem !== null,
    )
    return { ...config, configError: problems.length === 0 ? null : problems.join('; ') }
}

export const networkConfig: Readonly<NetworkConfig> = Object.freeze(readNetworkConfig())
