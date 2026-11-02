import { env } from 'node:process'

import { createEnvReader } from '#vendor/utils/env/env-reader.js'

const reader = createEnvReader()

const mailConfig = Object.freeze({
    enabled: reader.bool('SMTP_ENABLED', false),
    host: env['SMTP_HOST'] ?? '',
    port: reader.int('SMTP_PORT', 587, { min: 1, max: 65535 }),
    secure: reader.bool('SMTP_SECURE', false),
    requireTls: reader.bool('SMTP_REQUIRE_TLS', true),
    ignoreTls: reader.bool('SMTP_IGNORE_TLS', false),
    user: env['SMTP_USER'] ?? '',
    password: env['SMTP_PASSWORD'] ?? '',
    fromEmail: env['SMTP_FROM_EMAIL'] ?? '',
    fromName: env['SMTP_FROM_NAME'] ?? '',
    replyTo: env['SMTP_REPLY_TO'] ?? '',
    /** Every unreadable SMTP_* flag or number, or `null`; `validateRuntimeConfig` throws on it. */
    configError: reader.error,
})

export default mailConfig
