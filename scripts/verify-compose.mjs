// Checks that docker-compose.yml runs the app with the API prefix scripts/docker-build.sh builds
// the SPA for (feat-185), and the landing on the port docker-build.sh builds it for (feat-217): the shell's API_PATH_PREFIX, else the one in packages/backend/.env,
// else `api`; the healthcheck asks for /<prefix>/ready. Runs `docker compose config` on a copy
// of the file next to a generated .env, so the result does not depend on the local .env.
// Without the docker CLI it says so and passes: the CI quality job has it.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hasCompose = () => {
    try {
        execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
        return true
    } catch {
        return false
    }
}

if (!hasCompose()) {
    console.log('verify-compose: skipped, no `docker compose` here')
    process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'verify-compose-'))
const envFile = join(dir, 'packages', 'backend', '.env')
mkdirSync(join(dir, 'packages', 'backend'), { recursive: true })
copyFileSync('docker-compose.yml', join(dir, 'docker-compose.yml'))

/** The prefix and healthcheck of the app and migrate services for a shell value and a file. */
const resolve = (shellPrefix, fileLines) => {
    writeFileSync(envFile, fileLines.join('\n') + '\n')
    const env = { ...process.env }
    delete env.API_PATH_PREFIX
    if (shellPrefix !== undefined) env.API_PATH_PREFIX = shellPrefix
    const json = execFileSync(
        'docker',
        [
            'compose',
            '--project-directory',
            dir,
            '-f',
            join(dir, 'docker-compose.yml'),
            '--env-file',
            envFile,
            '--profile',
            'app',
            'config',
            '--format',
            'json',
        ],
        { env, encoding: 'utf8' },
    )
    const { services } = JSON.parse(json)
    return {
        app: services.app.environment.API_PATH_PREFIX,
        migrate: services.migrate.environment.API_PATH_PREFIX,
        health: services.app.healthcheck?.test?.join(' ') ?? '',
        landing: services.landing,
    }
}

/**
 * The landing service (packages/landing): in the `app` profile, published on 127.0.0.1 at
 * LANDING_PORT (the port scripts/docker-build.sh compiles into the landing as its own address),
 * with a healthcheck. Returns the problems.
 */
const landingProblems = (landing, wantPort) => {
    if (landing === undefined) return ['no `landing` service in the app profile']
    const problems = []
    const port = landing.ports?.[0]
    if (port?.host_ip !== '127.0.0.1')
        problems.push(`landing is published on ${port?.host_ip}, not 127.0.0.1`)
    if (String(port?.published) !== wantPort)
        problems.push(`landing is published on ${port?.published}, not LANDING_PORT ${wantPort}`)
    if (port?.target !== 8080)
        problems.push(`landing targets ${port?.target}, nginx listens on 8080`)
    if (!(landing.healthcheck?.test ?? []).join(' ').includes('/healthz'))
        problems.push('landing has no /healthz healthcheck')
    return problems
}

const cases = [
    {
        name: 'the shell wins over the file',
        shell: 'v1',
        file: ['API_PATH_PREFIX=api'],
        want: 'v1',
    },
    {
        name: 'the file when the shell has none',
        shell: undefined,
        file: ['API_PATH_PREFIX=v2'],
        want: 'v2',
    },
    { name: '`api` when neither has one', shell: undefined, file: [], want: 'api' },
]

let failed = 0
try {
    for (const [file, want] of [
        [[], '8080'],
        [['LANDING_PORT=9090'], '9090'],
    ]) {
        for (const problem of landingProblems(resolve(undefined, file).landing, want)) {
            failed += 1
            console.error(`verify-compose: ${problem}`)
        }
    }
    for (const c of cases) {
        const got = resolve(c.shell, c.file)
        const ok =
            got.app === c.want && got.migrate === c.want && got.health.includes(`/${c.want}/ready`)
        if (!ok) {
            failed += 1
            console.error(`verify-compose: ${c.name}: want ${c.want}, got ${JSON.stringify(got)}`)
        }
    }
} finally {
    rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) process.exit(1)
console.log(`verify-compose: ${String(cases.length)} prefix cases and the landing service passed`)
