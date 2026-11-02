import { env } from 'node:process'
import { createEnvReader } from '#vendor/utils/env/env-reader.js'
import { nonEmpty } from '#vendor/utils/env/non-empty.js'

const reader = createEnvReader()

export default Object.freeze({
    port: reader.int('REDIS_PORT', 6379, { min: 1, max: 65535 }),
    host: nonEmpty(env['REDIS_HOST']) ?? '127.0.0.1',
    password: nonEmpty(env['REDIS_PASSWORD']) ?? null,
    keyPrefix: nonEmpty(env['REDIS_PREFIX']) ?? 'uwebsocket:', // max 16 characters long, only letters, numbers, :,_,-
    /** Command timeout of the main (sessions, WS tokens) client. */
    commandTimeoutMs: reader.int('REDIS_COMMAND_TIMEOUT_MS', 500, { min: 1 }),
    /** Whole SCAN/DEL loop of destroyAllSessions (logoutAll). */
    logoutAllDeadlineMs: reader.int('REDIS_LOGOUT_ALL_DEADLINE_MS', 2000, { min: 1 }),
    configError: reader.error,
})
