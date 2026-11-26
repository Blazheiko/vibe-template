import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    envFileNames,
    interpolatedNames,
    prodComposeProblems,
    requiredNames,
    withPlaceholders,
} from './verify-compose-prod.mjs'

// A resolved production file that follows the plan (the shape `docker compose config` prints).
const good = () => {
    const env = {
        APP_ENV: 'production',
        APP_IS_PRODUCTION: 'true',
        SESSION_COOKIE_HOST_PREFIX: 'true',
        TRUST_PROXY: 'true',
        SERVE_STATIC: 'true',
        API_PATH_PREFIX: 'api',
        APP_URL: 'https://app.example.com',
        LANDING_URL: 'https://example.com',
    }
    const health = { test: ['CMD-SHELL', 'curl -fsS http://127.0.0.1:3000/api/ready'] }
    return {
        services: {
            migrate: {
                environment: { ...env },
                networks: { default: null, 'dokploy-network': null },
            },
            app: {
                build: { args: { API_PATH_PREFIX: 'api' } },
                environment: env,
                expose: ['3000'],
                healthcheck: health,
                restart: 'unless-stopped',
                networks: { default: null, 'dokploy-network': null },
            },
            landing: {
                build: {
                    args: {
                        LANDING_APP_URL: 'https://app.example.com',
                        LANDING_SITE_URL: 'https://example.com',
                    },
                },
                expose: ['8080'],
                healthcheck: { test: ['CMD', 'wget', 'http://127.0.0.1:8080/healthz'] },
                restart: 'unless-stopped',
            },
        },
        networks: { 'dokploy-network': { name: 'dokploy-network', external: true } },
    }
}

const problemsOf = (change) => {
    const config = good()
    change(config)
    return prodComposeProblems(config)
}

test('a file that follows the plan has no problems', () => {
    assert.deepEqual(prodComposeProblems(good()), [])
})

test('published ports are refused', () => {
    const problems = problemsOf((c) => {
        c.services.app.ports = [{ target: 3000, published: '3000' }]
    })
    assert.match(problems.join('\n'), /app publishes ports/)
})

test('a database service in the file is refused', () => {
    const problems = problemsOf((c) => {
        c.services.postgres = { image: 'pgvector/pgvector:pg16' }
        c.volumes = { 'postgres-data': {} }
    })
    assert.match(problems.join('\n'), /postgres is in the file/)
    assert.match(problems.join('\n'), /declares volumes/)
})

test('the SPA and the server must share the API prefix', () => {
    const problems = problemsOf((c) => {
        c.services.app.build.args.API_PATH_PREFIX = 'v2'
    })
    assert.match(problems.join('\n'), /built for API_PATH_PREFIX "v2"/)
})

test('the landing must be built for the addresses of the app', () => {
    const problems = problemsOf((c) => {
        c.services.landing.build.args.LANDING_APP_URL = 'https://other.example.com'
    })
    assert.match(problems.join('\n'), /landing buttons lead to/)
})

test('app and migrate must be on the external dokploy-network', () => {
    const problems = problemsOf((c) => {
        delete c.services.migrate.networks['dokploy-network']
        c.networks['dokploy-network'].external = false
    })
    assert.match(problems.join('\n'), /migrate is not on dokploy-network/)
    assert.match(problems.join('\n'), /not an external network/)
})

test('healthchecks, restart and production mode are required', () => {
    const problems = problemsOf((c) => {
        delete c.services.landing.healthcheck
        c.services.app.restart = 'no'
        c.services.app.environment.SESSION_COOKIE_HOST_PREFIX = 'false'
        c.services.app.labels = { 'traefik.enable': 'true' }
    })
    const text = problems.join('\n')
    assert.match(text, /landing has no healthcheck/)
    assert.match(text, /app restarts "no"/)
    assert.match(text, /SESSION_COOKIE_HOST_PREFIX=false/)
    assert.match(text, /Traefik labels/)
})

test('the names of the compose text and of an env file', () => {
    const text =
        'A: ${APP_DOMAIN:?set it}\nB: ${PORT:-3000}\nC: $${SHELL_ONLY}\nD: https://${APP_DOMAIN}'
    assert.deepEqual(interpolatedNames(text), ['APP_DOMAIN', 'PORT'])
    assert.deepEqual(requiredNames(text), ['APP_DOMAIN'])
    assert.deepEqual([...envFileNames('# X=1\nAPP_DOMAIN=a\n\nPORT=\n')], ['APP_DOMAIN', 'PORT'])
    assert.equal(withPlaceholders('APP_KEY=\nPORT=\n', ['APP_KEY']), 'APP_KEY=placeholder\nPORT=\n')
})
