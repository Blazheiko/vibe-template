import { type } from '@arktype/type'
import { describe, expect, it, vi } from 'vitest'

import {
    AVATAR_MAX_FILE_BYTES,
    KB_SCREENSHOT_MAX_FILE_BYTES,
    MULTIPART_OVERHEAD_BYTES,
    multipartBodyLimit,
} from '#app/services/shared/upload-limits.js'

// The session token handler (loaded with the route table) refuses to import without a
// key of at least 32 characters; this one signs nothing here.
vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})
const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))

const { routesHandler } = await import('#vendor/start/router.js')
const { default: httpRoutes } = await import('#app/routes/http-routes.js')

const routes = routesHandler(httpRoutes)

// feat-063: a multipart route carries the cap of its whole body, not just the global one.
describe('upload routes', () => {
    const multipartRoutes = routes.filter(
        (route) => route.allowedContentTypes?.includes('multipart') === true,
    )

    it('every multipart route has its own body limit', () => {
        expect(multipartRoutes.length).toBeGreaterThan(0)
        for (const route of multipartRoutes) {
            expect(route.maxBodySize, `${route.method} ${route.url}`).toBeDefined()
        }
    })

    it('limits the avatar upload to a 10 MiB file plus the multipart framing', () => {
        const route = routes.find((r) => r.url === 'api/avatar/upload')

        expect(AVATAR_MAX_FILE_BYTES).toBe(10 * 1024 * 1024)
        expect(route?.maxBodySize).toBe(AVATAR_MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES)
        expect(route?.maxBodySize).toBe(multipartBodyLimit(AVATAR_MAX_FILE_BYTES))
    })

    it('limits a knowledge-base screenshot to a 5 MiB file plus the multipart framing', () => {
        const route = routes.find(
            (r) => r.method === 'post' && r.url === 'api/admin/knowledge-base/:id/screenshot',
        )

        expect(KB_SCREENSHOT_MAX_FILE_BYTES).toBe(5 * 1024 * 1024)
        expect(route?.maxBodySize).toBe(multipartBodyLimit(KB_SCREENSHOT_MAX_FILE_BYTES))
    })

    it('rate-limits the avatar routes per IP', () => {
        const avatar = routes.filter((r) => r.url.startsWith('api/avatar/'))

        expect(avatar.length).toBeGreaterThan(0)
        for (const route of avatar) {
            expect(route.rateLimit, `${route.method} ${route.url}`).toEqual({
                windowMs: 60_000,
                maxRequests: 10,
            })
        }
    })

    it('keeps the upload limits below the global multipart limit', async () => {
        const { default: appConfig } = await import('#config/app.js')
        for (const route of multipartRoutes) {
            expect(route.maxBodySize ?? 0).toBeLessThanOrEqual(appConfig.maxMultipartBodySize)
        }
    })
})

// feat-202 (security review 2026-11-12, M-3): what a route lets an unauthenticated client make
// the server buffer.
describe('pre-auth body limits of the route table (feat-202)', async () => {
    const { default: appConfig } = await import('#config/app.js')
    const { resolveMaxBodySize } = await import('#vendor/utils/network/http-request-handlers.js')
    const { KB_ARTICLE_MAX_BODY_BYTES, PROMPT_MAX_BODY_BYTES, jsonBodyLimit } =
        await import('#app/services/shared/upload-limits.js')
    const shared = await import('shared/schemas')

    const withBody = routes.filter((route) => ['post', 'put', 'patch'].includes(route.method))
    const jsonLimitOf = (route: (typeof routes)[number]): number =>
        resolveMaxBodySize('json', route.maxBodySize)

    it('the default JSON limit is 100 KB, below the 2 MiB ceiling', () => {
        expect(appConfig.defaultJsonBodySize).toBe(102_400)
        expect(appConfig.defaultJsonBodySize).toBeLessThan(appConfig.maxJsonBodySize)
    })

    it('only the knowledge-base article and prompt routes take more JSON than the default', () => {
        const raised = withBody
            .filter(
                (route) =>
                    route.allowedContentTypes?.includes('multipart') !== true &&
                    jsonLimitOf(route) > appConfig.defaultJsonBodySize,
            )
            .map((route) => `${route.method} ${route.url}`)
            .sort()

        expect(raised).toEqual([
            'post api/admin/knowledge-base',
            'put api/admin/knowledge-base/:id',
            'put api/prompts/:type',
        ])
    })

    it('a text of the longest length the schema accepts fits the limit of its route', () => {
        // The worst encoding a client may choose: every character escaped as \uXXXX.
        const escaped = (chars: number): number => chars * 6
        // The lengths the helpers are given are the ones the schemas accept.
        const accepts = (schema: (value: unknown) => unknown, value: unknown): boolean =>
            !(schema(value) instanceof type.errors)
        const article = (chars: number) => ({ title: 'T', content: 'я'.repeat(chars) })
        expect(accepts(shared.SupportKnowledgeBaseCreateSchema, article(30_000))).toBe(true)
        expect(accepts(shared.SupportKnowledgeBaseCreateSchema, article(30_001))).toBe(false)
        expect(accepts(shared.PromptUpdateInputSchema, { content: 'я'.repeat(50_000) })).toBe(true)
        expect(accepts(shared.PromptUpdateInputSchema, { content: 'я'.repeat(50_001) })).toBe(false)

        expect(KB_ARTICLE_MAX_BODY_BYTES).toBe(jsonBodyLimit(30_000))
        expect(KB_ARTICLE_MAX_BODY_BYTES).toBeGreaterThan(escaped(30_000))
        expect(PROMPT_MAX_BODY_BYTES).toBe(jsonBodyLimit(50_000))
        expect(PROMPT_MAX_BODY_BYTES).toBeGreaterThan(escaped(50_000))
        expect(PROMPT_MAX_BODY_BYTES).toBeLessThanOrEqual(appConfig.maxJsonBodySize)
    })

    it('every multipart route refuses an anonymous request before the body is read', () => {
        const multipart = routes.filter(
            (route) => route.allowedContentTypes?.includes('multipart') === true,
        )

        expect(multipart.length).toBeGreaterThan(0)
        for (const route of multipart) {
            expect(route.signedInBeforeBody, `${route.method} ${route.url}`).toBe(true)
            // The flag is only right for a route that needs a signed-in user anyway.
            expect(route.middlewares, `${route.method} ${route.url}`).toContain('auth_guard')
        }
    })

    it('rate-limits the knowledge-base screenshot upload', () => {
        const route = routes.find(
            (r) => r.method === 'post' && r.url === 'api/admin/knowledge-base/:id/screenshot',
        )

        expect(route?.rateLimit).toEqual({ windowMs: 60_000, maxRequests: 10 })
    })
})
