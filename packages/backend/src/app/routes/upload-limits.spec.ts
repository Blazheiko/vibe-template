import { describe, expect, it, vi } from 'vitest'

import {
    AVATAR_MAX_FILE_BYTES,
    KB_SCREENSHOT_MAX_FILE_BYTES,
    MULTIPART_OVERHEAD_BYTES,
    multipartBodyLimit,
} from '#app/services/shared/upload-limits.js'

// session-api (loaded with the route table) refuses to import without a key of at
// least 32 characters; this one signs nothing here.
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
