import type { Type } from '@arktype/type'

import { defaultValidator } from '#app/validate/index.js'
import type { HttpContext, RouteConfig, RouteItem, TypedHandler } from '#vendor/types/types.js'
import type { RouteResponse } from '#app/routing/route-response.js'
import type { BodyMethod, HttpRouteMethod } from '#vendor/utils/routing/body-methods.js'

type InferSchema<TSchema> = TSchema extends Type<infer T> ? T : unknown

/**
 * Infers query type from optional schema:
 *  - schema provided → schema's output;
 *  - undefined       → null (matches runtime `httpData.query === null`).
 */
type InferQueryFromSchema<TSchema> = TSchema extends Type<infer T> ? T : null

type DefineRouteInput<
    TBody extends Type | undefined,
    TQuery extends Type | undefined,
    TRes extends Type | undefined,
> = Omit<RouteConfig, 'method' | 'validator' | 'queryValidator' | 'ResponseSchema'> &
    // A body validator is only allowed on methods that read a body; on
    // get/delete it would silently receive `payload = null`.
    (
        | { method: BodyMethod; validator?: TBody }
        | { method: Exclude<HttpRouteMethod, BodyMethod>; validator?: undefined }
    ) & {
        queryValidator?: TQuery
        queryAllowExtra?: boolean
        queryArrays?: readonly string[]
        ResponseSchema?: TRes
        handler: TypedHandler<
            HttpContext<InferSchema<TBody>, InferQueryFromSchema<TQuery>>,
            RouteResponse<TRes>
        >
    }

/**
 * Wraps an ArkType schema for query validation:
 *  - by default applies '+': 'reject' (strict — undeclared keys → 422);
 *  - when `allowExtra` is true, applies '+': 'delete' (loose+strip —
 *    undeclared keys pass validation but are removed from output).
 *
 * Implementation uses ArkType's `onUndeclaredKey` API so morphs/defaults are
 * preserved while only the extra-key policy changes.
 */
const applyStrictPolicy = <T>(schema: Type<T>, allowExtra: boolean): Type<T> =>
    schema.onUndeclaredKey(allowExtra ? 'delete' : 'reject') as unknown as Type<T>

/**
 * A route from schemas, without a contract. Not for the route table: every route of the
 * application is declared through its contract (`defineRoute` of app/routes/contract-schemas,
 * docs/adr/0005-route-contracts.md), and ESLint refuses this import in src/app outside tests.
 * It stays for the tests of the HTTP machinery (body methods, limits, validation, cache), which
 * build routes of their own.
 */
export function defineRawRoute<
    TBody extends Type | undefined = undefined,
    TQuery extends Type | undefined = undefined,
    TRes extends Type | undefined = undefined,
>(config: DefineRouteInput<TBody, TQuery, TRes>): RouteItem {
    const wrappedQueryValidator =
        config.queryValidator !== undefined
            ? defaultValidator(
                  applyStrictPolicy(config.queryValidator, config.queryAllowExtra === true),
              )
            : undefined

    return {
        ...config,
        validator: config.validator !== undefined ? defaultValidator(config.validator) : undefined,
        queryValidator: wrappedQueryValidator,
    }
}
