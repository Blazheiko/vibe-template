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

const maskUrl = (value: string): string => {
    try {
        const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
        const url = new URL(value, base)
        const params = ['token', 'code', 'state', 'access_token', 'id_token', 'secret']
        for (const param of params) {
            if (url.searchParams.has(param)) {
                url.searchParams.set(param, '[Filtered]')
            }
        }
        return url.toString()
    } catch {
        return value
    }
}

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
 * masked the same way in both.
 */
const sanitizeTree = (value: unknown, sensitive: 'drop' | 'filter'): unknown => {
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
        sanitized.message = maskUrl(sanitized.message)
    }

    if (sanitized.category === 'navigation' && sanitized.data) {
        sanitized.data = sanitizeTree(sanitized.data, 'filter')
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
