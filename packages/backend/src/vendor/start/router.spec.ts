import { type } from '@arktype/type'
import { describe, expect, it } from 'vitest'

import { defineRoute } from '#app/routing/define-route.js'
import { defineWsRoute } from '#app/routing/define-ws-route.js'
import type { routeList } from '#vendor/types/types.js'
import { routesHandler } from './router.js'

describe('routesHandler', () => {
    it('does not mutate source route definitions while flattening groups', () => {
        const loginRoute = defineRoute({
            url: '/login',
            method: 'post',
            middlewares: ['route_middleware'],
            handler: () => ({ ok: true }),
        })
        const routes = [
            {
                group: [loginRoute],
                description: 'Auth routes',
                middlewares: ['group_middleware'],
                prefix: 'auth',
            },
        ] satisfies routeList

        const firstResult = routesHandler(routes)
        const secondResult = routesHandler(routes)

        expect(loginRoute.url).toBe('/login')
        expect(loginRoute.middlewares).toEqual(['route_middleware'])
        expect(loginRoute.groupRateLimit).toBeUndefined()

        expect(firstResult[0]?.url).toBe(secondResult[0]?.url)
        expect(firstResult[0]?.url).toMatch(/\/auth\/login$/)
        expect(firstResult[0]?.middlewares).toEqual(['group_middleware', 'route_middleware'])
    })

    describe('body validator on methods without a body', () => {
        const schema = type({ id: 'string' })
        // Bypasses defineRoute's type check, like a hand-written route would.
        const withValidator = (method: 'get' | 'delete' | 'del') =>
            ({
                ...defineRoute({
                    url: '/items',
                    method: 'post',
                    validator: schema,
                    handler: () => ({}),
                }),
                method,
            }) as ReturnType<typeof defineRoute>

        it.each(['get', 'delete', 'del'] as const)('throws at startup for %s', (method) => {
            expect(() => routesHandler([withValidator(method)])).toThrow(
                /declares a body validator, but .* requests never read a body/,
            )
        })

        it('accepts get/delete routes without a body validator', () => {
            const routes = routesHandler([
                defineRoute({ url: '/items', method: 'get', handler: () => ({}) }),
                defineRoute({
                    url: '/items/:id',
                    method: 'delete',
                    handler: () => ({}),
                }),
            ])
            expect(routes.map((r) => r.method)).toEqual(['get', 'del'])
        })

        it('accepts patch routes with a validator', () => {
            const [route] = routesHandler([
                defineRoute({
                    url: '/items/:id',
                    method: 'patch',
                    validator: schema,
                    handler: () => ({}),
                }),
            ])
            expect(route?.validator).toBeDefined()
        })

        it('accepts WS routes with a validator (regression)', () => {
            const [route] = routesHandler([
                defineWsRoute({
                    url: 'join_room',
                    validator: schema,
                    handler: () => ({}),
                }),
            ])
            expect(route?.method).toBe('ws')
            expect(route?.validator).toBeDefined()
        })
    })
    describe('maxBodySize', () => {
        const upload = (maxBodySize: number | undefined, method: 'post' | 'get' = 'post') =>
            ({
                ...defineRoute({
                    url: '/upload',
                    method: 'post',
                    allowedContentTypes: ['multipart'],
                    handler: () => ({}),
                }),
                method,
                ...(maxBodySize !== undefined ? { maxBodySize } : {}),
            }) as ReturnType<typeof defineRoute>

        it('is carried into the normalized route', () => {
            const [route] = routesHandler([upload(1234)])
            expect(route?.maxBodySize).toBe(1234)
        })

        it('is undefined for a route that does not set it', () => {
            const [route] = routesHandler([upload(undefined)])
            expect(route?.maxBodySize).toBeUndefined()
        })

        it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
            'throws at startup for %s',
            (value) => {
                expect(() => routesHandler([upload(value)])).toThrow(
                    /maxBodySize must be a positive integer/,
                )
            },
        )

        it('throws at startup on a method that never reads a body', () => {
            expect(() => routesHandler([upload(1000, 'get')])).toThrow(
                /sets maxBodySize, but GET requests never read a body/,
            )
        })
    })
})
