// `?redirect=` names where to go after signing in. Whoever builds a link controls it, so it may
// only be a path inside the application: starting with a single `/`, with no backslash (browsers
// read `/\host` as `//host`) and no control characters.
const UNSAFE = /[\\\u0000-\u001f\u007f]/

export const safeRedirectTarget = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    if (!value.startsWith('/') || value.startsWith('//')) return null
    if (UNSAFE.test(value)) return null
    return value
}
