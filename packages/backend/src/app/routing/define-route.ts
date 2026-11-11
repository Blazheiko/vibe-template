import type { Type } from '@arktype/type'

import { defaultValidator } from '#app/validate/index.js'
import type { HttpContext, RouteConfig, RouteItem, TypedHandler } from '#vendor/types/types.js'
import type { RouteResponse } from '#app/routing/route-response.js'
import type { BodyMethod, HttpRouteMethod } from '#vendor/utils/routing/body-methods.js'
import type { AnyContract, BodyOf, QueryOf, ResponseOf } from 'shared/contracts'

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

// ---------------------------------------------------------------------------
// Routes declared through a contract (docs/adr/0005-route-contracts.md)
// ---------------------------------------------------------------------------

/** Makes a property impossible to satisfy, with the reason in the error message. */
interface ContractMismatch<TReason extends string> {
    readonly __contractMismatch: TReason
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** What a schema accepts before it parses or fills defaults: what a client sends. */
type SchemaInput<TSchema> = TSchema extends { inferIn: infer TIn } ? TIn : never
/** What a schema hands to the handler. */
type SchemaOutput<TSchema> = TSchema extends { infer: infer TOut } ? TOut : never

/**
 * The body schema of a contract route: none when the contract has no body, otherwise a schema
 * whose input is exactly the contract's body type.
 */
type ContractBody<C extends AnyContract, TBody extends Type | undefined> = [BodyOf<C>] extends [
    undefined,
]
    ? { validator?: undefined }
    : {
          validator: TBody &
              (Same<SchemaInput<TBody>, BodyOf<C>> extends true
                  ? unknown
                  : ContractMismatch<'the input of the body schema is not the body type of the contract'>)
      }

/**
 * The query schema of a contract route. A query schema parses strings into numbers and dates,
 * so the contract names what a client may send in its own words; the schema has to accept the
 * same keys.
 */
type ContractQuery<C extends AnyContract, TQuery extends Type | undefined> = [QueryOf<C>] extends [
    undefined,
]
    ? { queryValidator?: undefined }
    : {
          queryValidator: TQuery &
              (Same<keyof SchemaInput<TQuery>, keyof QueryOf<C>> extends true
                  ? unknown
                  : ContractMismatch<'the keys of the query schema are not the keys of the contract query'>)
      }

/** A response type without its error branch. */
type SuccessOf<T> = Exclude<T, { status: 'error' }>

/**
 * The response schema of a contract route: what it lets through on success is exactly the
 * contract's response type. The error branch is left out of the comparison: every route shares
 * one error envelope, and the type the client sees narrows its `details` on purpose
 * (`WithCanonicalError` in shared/responses/error-response.ts).
 */
interface ContractResponse<C extends AnyContract, TRes extends Type> {
    ResponseSchema: TRes &
        (Same<SuccessOf<SchemaOutput<TRes>>, SuccessOf<ResponseOf<C>>> extends true
            ? unknown
            : ContractMismatch<'the success answers of the response schema are not the response type of the contract'>)
}

type DefineContractRouteInput<
    C extends AnyContract,
    TBody extends Type | undefined,
    TQuery extends Type | undefined,
    TRes extends Type,
> = Omit<
    RouteConfig,
    'url' | 'method' | 'contractPath' | 'validator' | 'queryValidator' | 'ResponseSchema'
> &
    ContractBody<C, TBody> &
    ContractQuery<C, TQuery> &
    ContractResponse<C, TRes> & {
        /** Method, path and the three types: packages/shared/src/contracts. */
        contract: C
        queryAllowExtra?: boolean
        queryArrays?: readonly string[]
        handler: TypedHandler<
            HttpContext<InferSchema<TBody>, InferQueryFromSchema<TQuery>>,
            RouteResponse<TRes>
        >
    }

/**
 * A route declared through a contract: the method and the path come from the contract, and the
 * schemas given here are checked against its types at compile time. Middlewares, limits and
 * body kinds stay what they were: settings of the server, not part of the contract.
 */
export function defineContractRoute<
    C extends AnyContract,
    TBody extends Type | undefined = undefined,
    TQuery extends Type | undefined = undefined,
    TRes extends Type = Type,
>(config: DefineContractRouteInput<C, TBody, TQuery, TRes>): RouteItem {
    const { contract, ...rest } = config
    // The conditional types above are for callers; here the two schemas are just schemas.
    const { queryValidator, validator } = rest as unknown as {
        queryValidator?: Type
        validator?: Type
    }

    return {
        ...rest,
        url: contract.path,
        method: contract.method,
        contractPath: contract.path,
        validator: validator !== undefined ? defaultValidator(validator) : undefined,
        queryValidator:
            queryValidator !== undefined
                ? defaultValidator(
                      applyStrictPolicy(queryValidator, config.queryAllowExtra === true),
                  )
                : undefined,
    } as RouteItem
}

export function defineRoute<
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
