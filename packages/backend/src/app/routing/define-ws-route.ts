import type { Type } from '@arktype/type'

import { defaultValidator } from '#app/validate/index.js'
import type { RouteConfig, RouteItem, TypedHandler, WsContext } from '#vendor/types/types.js'
import type { RouteResponse } from '#app/routing/route-response.js'

type InferSchema<TSchema> = TSchema extends Type<infer T> ? T : unknown

type DefineWsRouteInput<TSchema extends Type | undefined, TRes extends Type | undefined> = Omit<
    RouteConfig,
    'method' | 'validator' | 'ResponseSchema'
> & {
    validator?: TSchema
    ResponseSchema?: TRes
    handler: TypedHandler<WsContext<InferSchema<TSchema>>, RouteResponse<TRes>>
}

/**
 * A WS route from schemas, without a contract. Not for the route table: every WS route of the
 * application is declared through its contract (`defineWsRoute` of app/routes/contract-schemas,
 * docs/adr/0006-websocket-contracts.md), and ESLint refuses this import in src/app outside
 * tests. It stays for the tests of the WS machinery, which build routes of their own.
 */
export function defineRawWsRoute<
    TSchema extends Type | undefined,
    TRes extends Type | undefined = undefined,
>(config: DefineWsRouteInput<TSchema, TRes>): RouteItem {
    return {
        method: 'ws',
        ...config,
        validator: config.validator !== undefined ? defaultValidator(config.validator) : undefined,
    }
}
