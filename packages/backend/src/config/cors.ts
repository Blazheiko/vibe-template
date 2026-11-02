import { env } from 'node:process'

import { createEnvReader } from '#vendor/utils/env/env-reader.js'

const reader = createEnvReader()

function parseOriginsList(value: string | undefined): readonly string[] {
    if (value === undefined || value.trim() === '') return []
    return value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
}

export default Object.freeze({
    /*
   |--------------------------------------------------------------------------
   | Enabled
   |--------------------------------------------------------------------------
   |
   | Toggle CORS handling. When disabled, no CORS headers are emitted and
   | preflight requests fall through to the default handler.
   |
   */
    enabled: reader.bool('ENABLED_CORS', false),

    /*
  |--------------------------------------------------------------------------
  | Allowed Origins (whitelist)
  |--------------------------------------------------------------------------
  |
  | Comma-separated list of origins allowed to make cross-origin requests.
  | The server reflects the request's Origin header only if it matches one of
  | these entries. Wildcards are NOT supported — entries must be full origins
  | like "https://app.example.com".
  |
  | An empty list means no cross-origin request is allowed even if
  | ENABLED_CORS=true.
  |
  | Example:
  |   CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
  |
  */
    allowedOrigins: parseOriginsList(env['CORS_ALLOWED_ORIGINS']),

    /*
  |--------------------------------------------------------------------------
  | Methods
  |--------------------------------------------------------------------------
  */
    methods: 'GET, POST, PUT, PATCH, DELETE, OPTIONS',

    /*
  |--------------------------------------------------------------------------
  | Expose Headers
  |--------------------------------------------------------------------------
  |
  | https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Expose-Headers
  |
  */
    exposeHeaders: 'Cache-Control Content-Language Content-Type Expires Last-Modified Pragma',

    /*
  |--------------------------------------------------------------------------
  | Allowed Request Headers
  |--------------------------------------------------------------------------
  |
  | https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers
  |
  */
    allowHeaders: 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-CSRF-Token',

    /*
  |--------------------------------------------------------------------------
  | Credentials
  |--------------------------------------------------------------------------
  |
  | Controls Access-Control-Allow-Credentials. Default is false — must be
  | explicitly enabled via env. The header is only emitted for origins that
  | are present in allowedOrigins (never with a wildcard).
  |
  | https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Credentials
  |
  */
    credentials: reader.bool('CREDENTIONALS_CORS', false),

    /*
  |--------------------------------------------------------------------------
  | MaxAge
  |--------------------------------------------------------------------------
  |
  | Define `Access-Control-Max-Age` header in seconds.
  | https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Max-Age
  |
  */
    maxAge: 90,

    /** An unreadable ENABLED_CORS / CREDENTIONALS_CORS flag, or `null`. */
    configError: reader.error,
})
