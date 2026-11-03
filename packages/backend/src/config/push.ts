import { createEnvReader } from '#vendor/utils/env/env-reader.js'

// The push services browsers subscribe with. An entry is an exact host; an entry that starts with
// a dot matches any subdomain on a DNS label boundary (`.notify.windows.com` matches
// `wns2-par02p.notify.windows.com`, not `evilnotify.windows.com`).
export const DEFAULT_ALLOWED_ENDPOINT_HOSTS: readonly string[] = [
    'fcm.googleapis.com',
    'updates.push.services.mozilla.com',
    '.notify.windows.com',
    'web.push.apple.com',
]

const HOST_ENTRY_RE = /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

function readAllowedHosts(raw: string | undefined): {
    hosts: readonly string[]
    error: string | null
} {
    if (raw === undefined || raw.trim() === '') {
        return { hosts: DEFAULT_ALLOWED_ENDPOINT_HOSTS, error: null }
    }

    const hosts = raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
    const invalid = hosts.filter((entry) => !HOST_ENTRY_RE.test(entry))
    if (hosts.length === 0 || invalid.length > 0) {
        return {
            hosts: DEFAULT_ALLOWED_ENDPOINT_HOSTS,
            error: `PUSH_ALLOWED_ENDPOINT_HOSTS must be a comma-separated list of host names or .domain suffixes${invalid.length > 0 ? `; not a host: ${invalid.join(', ')}` : ''}`,
        }
    }
    return { hosts, error: null }
}

export interface PushConfig {
    readonly vapidPublicKey: string
    readonly vapidPrivateKey: string
    readonly vapidSubject: string
    readonly allowedEndpointHosts: readonly string[]
    readonly maxSubscriptionsPerUser: number
    /** Every unreadable PUSH_* value, or `null`; `validateRuntimeConfig` throws on it. */
    readonly configError: string | null
}

export function readPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
    const reader = createEnvReader(env)
    const allowed = readAllowedHosts(env['PUSH_ALLOWED_ENDPOINT_HOSTS'])
    const maxSubscriptionsPerUser = reader.int('PUSH_MAX_SUBSCRIPTIONS_PER_USER', 20, { min: 1 })
    const problems = [allowed.error, reader.error].filter(
        (problem): problem is string => problem !== null,
    )

    return Object.freeze({
        vapidPublicKey: env['VAPID_PUBLIC_KEY'] ?? '',
        vapidPrivateKey: env['VAPID_PRIVATE_KEY'] ?? '',
        vapidSubject: env['VAPID_SUBJECT'] ?? 'mailto:admin@vibe-template.example',
        allowedEndpointHosts: allowed.hosts,
        maxSubscriptionsPerUser,
        configError: problems.length === 0 ? null : problems.join('; '),
    })
}

const config = readPushConfig()

export default config
