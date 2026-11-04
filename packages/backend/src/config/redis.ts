import { env } from 'node:process'
import { createEnvReader } from '#vendor/utils/env/env-reader.js'
import { nonEmpty } from '#vendor/utils/env/non-empty.js'

const reader = createEnvReader()

// feat-111: the prefix becomes part of every key and of the logout-all SCAN pattern, which
// sanitizeRedisKey checks against [A-Za-z0-9:_*-] and 86 characters; an unchecked prefix made
// every logout-all throw. `session:<21-char user token>:*` takes 31 of them, so 32 leave room.
const PREFIX_RE = /^[A-Za-z0-9:_-]{1,32}$/
const rawPrefix = nonEmpty(env['REDIS_PREFIX'])
const prefixError =
    rawPrefix === undefined || PREFIX_RE.test(rawPrefix)
        ? null
        : 'REDIS_PREFIX must be 1-32 characters of letters, digits, ":", "_" and "-"'

export default Object.freeze({
    port: reader.int('REDIS_PORT', 6379, { min: 1, max: 65535 }),
    host: nonEmpty(env['REDIS_HOST']) ?? '127.0.0.1',
    password: nonEmpty(env['REDIS_PASSWORD']) ?? null,
    keyPrefix: rawPrefix ?? 'uwebsocket:',
    /** Command timeout of the main (sessions, WS tokens) client. */
    commandTimeoutMs: reader.int('REDIS_COMMAND_TIMEOUT_MS', 500, { min: 1 }),
    /** Whole SCAN/DEL loop of destroyAllSessions (logoutAll). */
    logoutAllDeadlineMs: reader.int('REDIS_LOGOUT_ALL_DEADLINE_MS', 2000, { min: 1 }),
    configError: ((): string | null => {
        const problems = [reader.error, prefixError].filter((e): e is string => e !== null)
        return problems.length === 0 ? null : problems.join('; ')
    })(),
})
