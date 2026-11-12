import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

import { assertSameApiPrefix, resolveDevBackend, type DevBackend } from 'shared/dev-backend'

/**
 * The local backend this dev server proxies to, from the backend's own PORT, HOST and
 * API_PATH_PREFIX: the shell first, then packages/backend/.env (as dotenv does), then the defaults
 * 127.0.0.1:3000 and `api`. Changing the port or the prefix is one edit in that file.
 */
export const BACKEND_ENV_FILE = fileURLToPath(new URL('../backend/.env', import.meta.url))

export function readDevBackend(
    envFile: string = BACKEND_ENV_FILE,
    shell: NodeJS.ProcessEnv = process.env,
): DevBackend {
    const file = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
    return resolveDevBackend(shell, file)
}

const FRONTEND_ENV_FILES = [
    '.env',
    '.env.local',
    '.env.development',
    '.env.development.local',
    '.env.production',
    '.env.production.local',
]

/**
 * Compiles the backend's prefix into the bundle as VITE_API_PATH_PREFIX (Vite lets a variable
 * already in process.env win over the .env files). A different value set by hand in a frontend
 * .env file or in the shell fails the config instead of being silently ignored.
 */
export function pinApiPrefix(
    prefix: string,
    root: string = process.cwd(),
    shell: NodeJS.ProcessEnv = process.env,
): void {
    // The files Vite reads in dev and build (loadEnv would also merge process.env, set below).
    for (const name of FRONTEND_ENV_FILES) {
        const file = join(root, name)
        if (!existsSync(file)) continue
        assertSameApiPrefix(parseEnv(readFileSync(file, 'utf8')).VITE_API_PATH_PREFIX, prefix)
    }
    assertSameApiPrefix(shell.VITE_API_PATH_PREFIX, prefix)
    shell.VITE_API_PATH_PREFIX = prefix
}
