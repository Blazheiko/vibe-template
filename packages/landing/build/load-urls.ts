import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { parseEnv } from 'node:util'
import { resolveLandingUrls, type LandingUrls } from './urls'

const BACKEND_ENV_FILE = fileURLToPath(new URL('../../backend/.env', import.meta.url))

/**
 * The addresses of this build: the shell, else packages/backend/.env, else the dev servers
 * (build/urls.ts). The landing needs no .env of its own. Shared by vite.config.ts and the
 * Playwright tests, so both expect the same buttons.
 */
export function loadLandingUrls(env: NodeJS.ProcessEnv = process.env): LandingUrls {
    const backendEnv = existsSync(BACKEND_ENV_FILE)
        ? parseEnv(readFileSync(BACKEND_ENV_FILE, 'utf8'))
        : {}
    return resolveLandingUrls(env, backendEnv)
}
