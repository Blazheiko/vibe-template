import type { App } from 'vue'
import { unref } from 'vue'
import type { Router } from 'vue-router'
import * as Sentry from '@sentry/vue'
import { i18n } from '@/plugins/i18n'
import { sentryConfig } from './sentry-config'

export interface SentryContext {
    route?: string
    tags?: Record<string, string>
    extra?: Record<string, unknown>
}

export type SentryLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'

interface SentryScopeLike {
    setTag(key: string, value: string): void
    setExtra(key: string, value: unknown): void
}

interface SentryEventLike extends Record<string, unknown> {
    user?: unknown
    request?: {
        headers?: unknown
        data?: unknown
        url?: unknown
    }
    breadcrumbs?: (Record<string, unknown> | null)[]
    extra?: unknown
}

interface SentrySpanLike extends Record<string, unknown> {
    name?: unknown
    attributes?: Record<string, unknown>
}

interface SentryBreadcrumbLike extends Record<string, unknown> {
    data?: unknown
    message?: unknown
    category?: unknown
}

const URL_KEY_RE = /^(url|uri|href|from|to|path|fullPath)$/i
const SENSITIVE_KEY_RE = /password|token|secret|cookie|auth|api[_-]?key|bearer/i

let enabled = sentryConfig.enabled
let initialized = false
let boundRouter: Router | null = null

const getRoutePath = (): string => {
    const currentRoute = boundRouter?.currentRoute.value
    return currentRoute?.path || currentRoute?.fullPath || '/'
}

const getRouteName = (): string => {
    const name = boundRouter?.currentRoute.value.name
    return name === undefined ? 'unknown' : String(name)
}

const getLocale = (): string => unref(i18n.global.locale)

const SENSITIVE_QUERY_PARAMS = new Set([
    'token',
    'code',
    'state',
    'access_token',
    'id_token',
    'secret',
])

const isSensitiveQueryParam = (name: string): boolean =>
    SENSITIVE_QUERY_PARAMS.has(name.toLowerCase()) || SENSITIVE_KEY_RE.test(name)

/** Replaces the sensitive values of a `URLSearchParams`; true when one was replaced. */
const filterSearchParams = (params: URLSearchParams): boolean => {
    let filtered = false
    for (const name of new Set(params.keys())) {
        if (isSensitiveQueryParam(name)) {
            params.set(name, '[Filtered]')
            filtered = true
        }
    }
    return filtered
}

/** A raw query string without the leading `?` (the span attribute `url.query`). */
const maskQueryString = (value: string): string => {
    const params = new URLSearchParams(value)
    return filterSearchParams(params) ? params.toString() : value
}

const maskUrl = (value: string): string => {
    try {
        const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
        const url = new URL(value, base)
        return filterSearchParams(url.searchParams) ? url.toString() : value
    } catch {
        return value
    }
}

const ABSOLUTE_URL_RE = /https?:\/\/[^\s"'<>]+/g
const RELATIVE_URL_RE = /^\/\S*$/

/**
 * Masks the URLs of a free text and leaves the rest as it is: `maskUrl` on a whole sentence
 * turns it into a URL (`WebSocket connected` became `https://host/WebSocket%20connected`).
 */
const maskUrlsInText = (text: string): string =>
    RELATIVE_URL_RE.test(text) ? maskUrl(text) : text.replace(ABSOLUTE_URL_RE, maskUrl)

const sanitizeHeaders = (headers: unknown): unknown => {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        return headers
    }

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(headers)) {
        if (/^(authorization|cookie)$/i.test(key)) {
            result[key] = '[Filtered]'
            continue
        }

        if (typeof value === 'string' && URL_KEY_RE.test(key)) {
            result[key] = maskUrl(value)
            continue
        }

        result[key] = value
    }

    return result
}

/**
 * Walks a value that goes to Sentry and takes out what must not leave the browser. A key that
 * looks sensitive (password, token, cookie, authorization…) is dropped from request data
 * (`drop`) and kept with the value `[Filtered]` in breadcrumb data (`filter`), where the
 * breadcrumb is more useful knowing the key was there; headers and URL-like strings are
 * masked the same way in both, and a URL inside any other string (`extra.targetRoute`) too.
 */
const sanitizeTree = (value: unknown, sensitive: 'drop' | 'filter'): unknown => {
    if (typeof value === 'string') {
        return maskUrlsInText(value)
    }

    if (typeof value !== 'object' || value === null) {
        return value
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeTree(item, sensitive))
    }

    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            if (sensitive === 'filter') {
                result[key] = '[Filtered]'
            }
            continue
        }

        if (key === 'headers') {
            result[key] = sanitizeHeaders(child)
            continue
        }

        if (typeof child === 'string' && URL_KEY_RE.test(key)) {
            result[key] = maskUrl(child)
            continue
        }

        result[key] = sanitizeTree(child, sensitive)
    }

    return result
}

const sanitizeUser = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== 'object') {
        return undefined
    }

    const user = value as Record<string, unknown>
    if (typeof user.id !== 'string' && typeof user.id !== 'number') {
        return undefined
    }

    return { id: String(user.id) }
}

const applyContext = (scope: SentryScopeLike, ctx?: SentryContext) => {
    scope.setTag('route', ctx?.route || getRoutePath())
    scope.setTag('routeName', getRouteName())
    scope.setTag('locale', getLocale())

    if (ctx?.tags) {
        for (const [key, value] of Object.entries(ctx.tags)) {
            scope.setTag(key, value)
        }
    }

    if (ctx?.extra) {
        for (const [key, value] of Object.entries(ctx.extra)) {
            scope.setExtra(key, value)
        }
    }
}

const buildInitOptions = () => {
    const integrations: unknown[] = []

    integrations.push(
        Sentry.browserTracingIntegration({
            router: boundRouter ?? undefined,
        }),
    )

    if (sentryConfig.replaysSessionSampleRate > 0 || sentryConfig.replaysOnErrorSampleRate > 0) {
        const replay = Sentry.replayIntegration({
            maskAllText: true,
            maskAllInputs: true,
        })
        integrations.push(replay)
    }

    return integrations
}

const beforeSend = (event: SentryEventLike) => {
    const sanitizedEvent: SentryEventLike = {
        ...event,
    }

    if (sanitizedEvent.user) {
        sanitizedEvent.user = sanitizeUser(sanitizedEvent.user) ?? undefined
    }

    if (sanitizedEvent.request) {
        sanitizedEvent.request = {
            ...sanitizedEvent.request,
            headers: sanitizeHeaders(sanitizedEvent.request.headers),
            data: sanitizeTree(sanitizedEvent.request.data, 'drop'),
            url:
                typeof sanitizedEvent.request.url === 'string'
                    ? maskUrl(sanitizedEvent.request.url)
                    : sanitizedEvent.request.url,
        }
    }

    if (sanitizedEvent.extra) {
        sanitizedEvent.extra = sanitizeTree(sanitizedEvent.extra, 'filter')
    }

    if (Array.isArray(sanitizedEvent.breadcrumbs)) {
        sanitizedEvent.breadcrumbs = sanitizedEvent.breadcrumbs.map(
            (breadcrumb: Record<string, unknown> | null) => {
                if (!breadcrumb) return breadcrumb
                return beforeBreadcrumb({ ...breadcrumb })
            },
        )
    }

    return sanitizedEvent
}

const beforeBreadcrumb = (breadcrumb: SentryBreadcrumbLike | null) => {
    if (!breadcrumb) {
        return breadcrumb
    }

    const sanitized: SentryBreadcrumbLike = {
        ...breadcrumb,
    }

    if (sanitized.data) {
        sanitized.data = sanitizeTree(sanitized.data, 'filter')
    }

    if (typeof sanitized.message === 'string') {
        sanitized.message = maskUrlsInText(sanitized.message)
    }

    if (sanitized.category === 'navigation' && sanitized.data) {
        sanitized.data = sanitizeTree(sanitized.data, 'filter')
    }

    return sanitized
}

const QUERY_PARAM_ATTRIBUTE_RE = /^query\.(.+)$/
const QUERY_STRING_ATTRIBUTE_RE = /^(url|http)\.query$/

const maskSpanString = (key: string, value: string): string => {
    const param = QUERY_PARAM_ATTRIBUTE_RE.exec(key)?.[1]
    if ((param !== undefined && isSensitiveQueryParam(param)) || SENSITIVE_KEY_RE.test(key)) {
        return '[Filtered]'
    }

    return QUERY_STRING_ATTRIBUTE_RE.test(key) ? maskQueryString(value) : maskUrlsInText(value)
}

const sanitizeSpanAttribute = (key: string, value: unknown): unknown => {
    if (typeof value === 'string') {
        return maskSpanString(key, value)
    }

    if (Array.isArray(value)) {
        return value.map((item) => (typeof item === 'string' ? maskSpanString(key, item) : item))
    }

    // A typed attribute `{ value, type }`.
    if (
        value &&
        typeof value === 'object' &&
        typeof (value as { value?: unknown }).value === 'string'
    ) {
        const typed = value as { value: string }
        return { ...typed, value: maskSpanString(key, typed.value) }
    }

    return value
}

/**
 * `beforeSend` does not see tracing: spans leave through `beforeSendSpan` (Sentry 11 streams
 * them by default, so `beforeSendTransaction` is not called). The Vue router integration copies
 * every query parameter into a `query.<name>` attribute and the URL into `url.full`, so an open
 * `/reset-password?token=…` would send the token; both are masked here.
 */
const beforeSendSpan = (span: SentrySpanLike): SentrySpanLike => {
    const sanitized: SentrySpanLike = { ...span }

    if (typeof sanitized.name === 'string') {
        sanitized.name = maskUrlsInText(sanitized.name)
    }

    if (sanitized.attributes && typeof sanitized.attributes === 'object') {
        sanitized.attributes = Object.fromEntries(
            Object.entries(sanitized.attributes).map(([key, value]) => [
                key,
                sanitizeSpanAttribute(key, value),
            ]),
        )
    }

    return sanitized
}

export const sentryService = {
    init(app: App, router: Router): void {
        if (!sentryConfig.enabled || !enabled) {
            enabled = false
            return
        }

        if (initialized) {
            return
        }

        try {
            boundRouter = router
            const integrations = buildInitOptions()

            Sentry.init({
                app,
                dsn: sentryConfig.dsn,
                environment: sentryConfig.environment,
                release: sentryConfig.release,
                tracesSampleRate: sentryConfig.tracesSampleRate,
                replaysSessionSampleRate: sentryConfig.replaysSessionSampleRate,
                replaysOnErrorSampleRate: sentryConfig.replaysOnErrorSampleRate,
                maxBreadcrumbs: 50,
                // Sentry 11 removed `sendDefaultPii` and collects user info, cookies and
                // bodies by default; keep the previous `sendDefaultPii: false` behaviour.
                dataCollection: {
                    userInfo: false,
                    cookies: false,
                    httpBodies: [],
                    genAI: { inputs: false, outputs: false },
                    stackFrameVariables: false,
                },
                integrations: (defaultIntegrations: unknown[] = []) =>
                    [...defaultIntegrations, ...integrations] as never,
                beforeSend: beforeSend as never,
                beforeBreadcrumb: beforeBreadcrumb as never,
                beforeSendSpan: beforeSendSpan as never,
            })

            initialized = true
            enabled = true
        } catch (error) {
            enabled = false
            initialized = false
            boundRouter = null
            console.warn('[Sentry] Frontend initialization failed:', error)
        }
    },

    isEnabled(): boolean {
        return enabled && initialized
    },

    captureException(err: unknown, ctx?: SentryContext): void {
        if (!this.isEnabled()) {
            return
        }

        Sentry.withScope((scope: SentryScopeLike) => {
            applyContext(scope, ctx)
            Sentry.captureException(err)
        })
    },

    captureMessage(message: string, level: SentryLevel = 'info', ctx?: SentryContext): void {
        if (!this.isEnabled()) {
            return
        }

        Sentry.withScope((scope: SentryScopeLike) => {
            applyContext(scope, ctx)
            Sentry.captureMessage(message, level)
        })
    },

    setUser(user: { id: string } | null): void {
        if (!this.isEnabled()) {
            return
        }

        Sentry.setUser(user ? { id: user.id } : null)
    },

    withScope<T>(ctx: SentryContext, fn: () => T): T {
        if (!this.isEnabled()) {
            return fn()
        }

        return Sentry.withScope((scope: SentryScopeLike) => {
            applyContext(scope, ctx)
            return fn()
        })
    },

    flush(timeoutMs = 2000): Promise<boolean> {
        if (!this.isEnabled()) {
            return Promise.resolve(true)
        }

        return Sentry.flush(timeoutMs)
    },
}
