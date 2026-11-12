// Where the local backend listens and which API prefix it serves, for the dev tooling that has to
// reach it: the Vite configs of the frontend and the API playground (proxy target, proxy key and
// the prefix compiled into the bundle). One source of truth: the backend's own variables, read
// the way the backend reads them — dotenv keeps a variable already in the environment, so the
// shell wins over packages/backend/.env, and an empty value falls back to the default.
//
// Pure functions: the caller reads packages/backend/.env (node:fs + node:util parseEnv) and passes
// both sources in, so this module needs no Node types and stays importable anywhere.

import { normalizeApiPrefix } from '../ws-client/index.js'

/** Environment variables: `process.env`, or the parsed lines of a `.env` file. */
export type EnvSource = Readonly<Record<string, string | undefined>>

export interface DevBackend {
    /** `http://<host>:<port>`: the dev proxy target. */
    readonly origin: string
    readonly port: number
    /** API_PATH_PREFIX without outer slashes (`api`, `v1`, `v2/backend`). */
    readonly prefix: string
}

const DEFAULT_PORT = 3000
// HOST=0.0.0.0 / :: means "every interface": the proxy connects over loopback.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]'])

/** The value the backend sees: the shell's if it has the key (dotenv), else the file's; '' = unset. */
const read = (key: string, shell: EnvSource, file: EnvSource): string | undefined => {
    const value = Object.hasOwn(shell, key) ? shell[key] : file[key]
    const trimmed = value?.trim()
    return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

const parsePort = (raw: string | undefined): number => {
    if (raw === undefined) return DEFAULT_PORT
    const port = Number(raw)
    if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
        throw new Error(`PORT=${raw}: expected an integer from 1 to 65535 (packages/backend/.env)`)
    }
    return port
}

const proxyHost = (raw: string | undefined): string => {
    if (raw === undefined || WILDCARD_HOSTS.has(raw)) return '127.0.0.1'
    // An IPv6 literal needs brackets in a URL.
    return raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
}

/**
 * The local backend's address and API prefix from PORT, HOST and API_PATH_PREFIX. Throws on a PORT
 * the backend would refuse too. APP_UNIX_PATH is not looked at: a backend on a unix socket has no
 * HOST:PORT for the dev proxy.
 */
export const resolveDevBackend = (shell: EnvSource, file: EnvSource = {}): DevBackend => {
    const port = parsePort(read('PORT', shell, file))
    return {
        origin: `http://${proxyHost(read('HOST', shell, file))}:${String(port)}`,
        port,
        prefix: normalizeApiPrefix(read('API_PATH_PREFIX', shell, file)),
    }
}

/**
 * VITE_API_PATH_PREFIX is not a setting: the Vite config derives it from API_PATH_PREFIX. A value
 * set by hand (a frontend .env file or the shell) is accepted only when it says the same, so two
 * sources can never drift apart silently.
 */
export const assertSameApiPrefix = (clientValue: string | undefined, prefix: string): void => {
    if (clientValue === undefined || clientValue.trim() === '') return
    if (normalizeApiPrefix(clientValue) === prefix) return
    throw new Error(
        `VITE_API_PATH_PREFIX=${clientValue} differs from the backend API_PATH_PREFIX (${prefix}). Remove VITE_API_PATH_PREFIX: the prefix comes from API_PATH_PREFIX in packages/backend/.env or the environment`,
    )
}
