// The playground logs each request it makes. A header that carries a credential is shown as a
// placeholder, whatever the case of its name: the console of a shared machine or a pasted log
// must not hold a session or a token.
const SENSITIVE_HEADER =
    /^(authorization|proxy-authorization|cookie|set-cookie)$|token|api-?key|secret/i

export const REDACTED = '[redacted]'

export const redactHeaders = (headers: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
            name,
            SENSITIVE_HEADER.test(name) ? REDACTED : value,
        ]),
    )
