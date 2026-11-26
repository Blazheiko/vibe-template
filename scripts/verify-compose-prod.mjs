// The rules of docker-compose-prod.yml (feat-218, docs/plan/prod-compose-dokploy-plan.md), as pure
// functions of the file's text and of `docker compose config --format json`: verify-compose.mjs
// runs them on the real file, verify-compose-prod.test.mjs on broken copies.

/** The compose text without its comment lines: a comment may quote `${VAR:?...}`. */
const withoutComments = (text) =>
    text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n')

/** Every `${NAME...}` the compose text interpolates (`$${NAME}` is a literal for the shell). */
export function interpolatedNames(text) {
    const names = new Set()
    for (const match of withoutComments(text).matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g))
        names.add(match[1])
    return [...names].sort()
}

/** The names a `${NAME:?...}` makes required. */
export function requiredNames(text) {
    const names = new Set()
    for (const match of withoutComments(text).matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*):\?/g))
        names.add(match[1])
    return [...names].sort()
}

/** The NAME= keys of an env file (comments and blank lines skipped). */
export function envFileNames(text) {
    const names = new Set()
    for (const line of text.split('\n')) {
        const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)
        if (match) names.add(match[1])
    }
    return names
}

/** The env file with every empty required value filled, so `config` can resolve it. */
export function withPlaceholders(text, required) {
    return text
        .split('\n')
        .map((line) => {
            const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*$/.exec(line)
            return match && required.includes(match[1]) ? `${match[1]}=placeholder` : line
        })
        .join('\n')
}

const DATABASE_SERVICES = ['postgres', 'redis', 'db', 'database', 'pgvector']

/**
 * The problems of a resolved production compose file (`docker compose config --format json`):
 * an empty list when it follows the plan.
 */
export function prodComposeProblems(config) {
    const problems = []
    const services = config.services ?? {}
    for (const name of ['migrate', 'app', 'landing']) {
        if (services[name] === undefined) problems.push(`no \`${name}\` service`)
    }
    for (const [name, service] of Object.entries(services)) {
        if ((service.ports ?? []).length > 0) {
            problems.push(`${name} publishes ports: use expose, the proxy of Dokploy routes to it`)
        }
        if (DATABASE_SERVICES.includes(name)) {
            problems.push(`${name} is in the file: the databases are Database services of Dokploy`)
        }
        const labels = Object.keys(service.labels ?? {})
        if (labels.some((label) => label.startsWith('traefik.'))) {
            problems.push(
                `${name} has Traefik labels: domains belong to the Domains tab of Dokploy`,
            )
        }
        for (const volume of service.volumes ?? []) {
            if (volume.type === 'bind') problems.push(`${name} bind-mounts ${volume.source}`)
        }
    }
    if (Object.keys(config.volumes ?? {}).length > 0) {
        problems.push('the file declares volumes: the data lives in the Database services')
    }

    for (const name of ['app', 'landing']) {
        const service = services[name]
        if (service === undefined) continue
        if ((service.healthcheck?.test ?? []).length === 0)
            problems.push(`${name} has no healthcheck`)
        if (service.restart !== 'unless-stopped') {
            problems.push(`${name} restarts "${service.restart}", not unless-stopped`)
        }
    }

    const network = config.networks?.['dokploy-network']
    if (network?.external !== true) problems.push('dokploy-network is not an external network')
    for (const name of ['app', 'migrate']) {
        const service = services[name]
        if (service !== undefined && !Object.hasOwn(service.networks ?? {}, 'dokploy-network')) {
            problems.push(`${name} is not on dokploy-network: it would not reach the databases`)
        }
    }

    const app = services.app
    if (app !== undefined) {
        const env = app.environment ?? {}
        const built = app.build?.args?.API_PATH_PREFIX
        if (built !== env.API_PATH_PREFIX) {
            problems.push(
                `the SPA is built for API_PATH_PREFIX "${built}" and the server runs with "${env.API_PATH_PREFIX}"`,
            )
        }
        if (services.migrate?.environment?.API_PATH_PREFIX !== env.API_PATH_PREFIX) {
            problems.push('migrate and app run with different API_PATH_PREFIX')
        }
        const health = (app.healthcheck?.test ?? []).join(' ')
        if (!health.includes(`/${env.API_PATH_PREFIX}/ready`)) {
            problems.push(`the app healthcheck does not ask /${env.API_PATH_PREFIX}/ready`)
        }
        const fixed = {
            APP_ENV: 'production',
            APP_IS_PRODUCTION: 'true',
            SESSION_COOKIE_HOST_PREFIX: 'true',
            TRUST_PROXY: 'true',
            SERVE_STATIC: 'true',
        }
        for (const [key, want] of Object.entries(fixed)) {
            if (env[key] !== want) problems.push(`app runs with ${key}=${env[key]}, not ${want}`)
        }
        if (!String(env.APP_URL ?? '').startsWith('https://')) {
            problems.push(`APP_URL "${env.APP_URL}" is not https://`)
        }
        const landingArgs = services.landing?.build?.args ?? {}
        if (landingArgs.LANDING_APP_URL !== env.APP_URL) {
            problems.push(
                `the landing buttons lead to "${landingArgs.LANDING_APP_URL}", the app is "${env.APP_URL}"`,
            )
        }
        if (landingArgs.LANDING_SITE_URL !== env.LANDING_URL) {
            problems.push(
                `the landing is built for "${landingArgs.LANDING_SITE_URL}", LANDING_URL is "${env.LANDING_URL}"`,
            )
        }
    }
    return problems
}
