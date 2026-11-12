import type { Type } from '@arktype/type'

import { defaultValidator } from '#app/validate/index.js'
import type {
    HttpContext,
    RouteConfig,
    RouteItem,
    TypedHandler,
    WsContext,
} from '#vendor/types/types.js'
import type { RouteResponse } from '#app/routing/route-response.js'
import type { AnyContract, BodyOf, FieldsOf, KindOf, QueryOf, ResponseOf } from 'shared/contracts'
import type { QueryInputOf } from 'shared/schemas'

// The schemas of the routes declared through a contract (docs/adr/0005-route-contracts.md,
// "Цільовий стан"): one registry, keyed by the method and the path of the contract, so a route
// names its contract and nothing else. The registry lives in the backend: the schemas never
// reach the browser bundle, and the playground gets them from the serialized routes.

/** Makes a property impossible to satisfy, with the reason in the error message. */
export interface ContractMismatch<TReason extends string> {
    readonly __contractMismatch: TReason
}

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** What a schema accepts before it parses or fills defaults: what a client sends. */
type SchemaInput<TSchema> = TSchema extends { inferIn: infer TIn } ? TIn : never
/** What a schema hands to the handler. */
type SchemaOutput<TSchema> = TSchema extends { infer: infer TOut } ? TOut : never

/** A response type without its error branch. */
type SuccessOf<T> = Exclude<T, { status: 'error' }>

/**
 * What the body schema of a route checks: the body of a JSON contract, the text fields of a
 * multipart one (its files are read from `httpData.files`, not validated by the schema).
 */
type CheckedBodyOf<C> = KindOf<C> extends 'multipart' ? FieldsOf<C> : BodyOf<C>

/** The schemas of one route. `body` and `query` are there exactly when the contract has them. */
export interface SchemaEntry {
    readonly body?: Type
    readonly query?: Type
    readonly response: Type
}

/**
 * What an entry has to be for its contract:
 * - a body schema whose input is exactly the contract's body type, and none without a body;
 * - a query schema whose `QueryInputOf` is exactly the contract's query: the same keys, the same
 *   optionality, and values as a client sends them (a parsed number as a number or its text, a
 *   date as text), and none without a query;
 * - a response schema whose success answers are exactly the contract's response type. The error
 *   branch is left out: every route shares one error envelope, and the client's type narrows its
 *   `details` on purpose (`WithCanonicalError` in shared/responses/error-response.ts).
 */
type EntryCheck<C extends AnyContract, E> = ([BodyOf<C>] extends [undefined]
    ? { readonly body?: undefined }
    : {
          readonly body: E extends { body: infer B }
              ? Same<SchemaInput<B>, CheckedBodyOf<C>> extends true
                  ? unknown
                  : ContractMismatch<'the input of the body schema is not the body type of the contract'>
              : Type
      }) &
    ([QueryOf<C>] extends [undefined]
        ? { readonly query?: undefined }
        : {
              readonly query: E extends {
                  query: infer Q extends { inferIn: object; infer: object }
              }
                  ? Same<QueryInputOf<Q>, QueryOf<C>> extends true
                      ? unknown
                      : ContractMismatch<'what the query schema accepts is not the query type of the contract'>
                  : Type
          }) & {
        readonly response: E extends { response: infer R }
            ? Same<SuccessOf<SchemaOutput<R>>, SuccessOf<ResponseOf<C>>> extends true
                ? unknown
                : ContractMismatch<'the success answers of the response schema are not the response type of the contract'>
            : Type
    }

/** The registry key of a contract: `post /push-subscriptions`. */
export type ContractKey<C extends AnyContract> = `${C['method']} ${C['path']}`

const keyOf = (contract: AnyContract): string => `${contract.method} ${contract.path}`

/** The registry part of one group of contracts. */
export type GroupSchemas<
    G extends Record<string, AnyContract>,
    E extends { readonly [K in keyof G]?: SchemaEntry },
> = { readonly [K in keyof G as ContractKey<G[K]>]: Exclude<E[K], undefined> }

/**
 * The schemas of a group of contracts, one entry per contract of the group (a contract left out
 * does not compile). Each entry is checked against its contract by the compiler.
 */
export function contractSchemas<
    G extends Record<string, AnyContract>,
    // Optional here, so that a missing entry is reported as a missing property of `entries`
    // (the mapped type below requires every contract of the group).
    const E extends { readonly [K in keyof G]?: SchemaEntry },
>(group: G, entries: E & { readonly [K in keyof G]: EntryCheck<G[K], E[K]> }): GroupSchemas<G, E> {
    const registry: Record<string, SchemaEntry> = {}
    for (const name of Object.keys(group)) {
        const contract = group[name]
        const entry = (entries as Record<string, SchemaEntry | undefined>)[name]
        if (contract === undefined || entry === undefined) continue
        registry[keyOf(contract)] = entry
    }
    return registry as GroupSchemas<G, E>
}

/** The payload a handler sees: the output of the body schema. */
type PayloadOf<TSchema> = TSchema extends { infer: infer T } ? T : unknown
/** The query a handler sees: the output of the query schema, or null without one (as at run time). */
type QueryOutputOf<TSchema> = TSchema extends { infer: infer T } ? T : null

type EntryOf<R, C extends AnyContract> = ContractKey<C> extends keyof R ? R[ContractKey<C>] : never

type ContractRouteInput<R, C extends AnyContract> = Omit<
    RouteConfig,
    'url' | 'method' | 'contractPath' | 'validator' | 'queryValidator' | 'ResponseSchema'
> & {
    /** Method, path and the three types: packages/shared/src/contracts. */
    contract: C &
        (ContractKey<C> extends keyof R
            ? unknown
            : ContractMismatch<'the contract has no entry in the schema registry'>)
    queryAllowExtra?: boolean
    queryArrays?: readonly string[]
    // Without an entry the contract above is already the error; the handler is not checked.
    handler: [EntryOf<R, C>] extends [never]
        ? (...args: never[]) => unknown
        : TypedHandler<
              HttpContext<
                  PayloadOf<EntryOf<R, C> extends { body: infer B } ? B : undefined>,
                  QueryOutputOf<EntryOf<R, C> extends { query: infer Q } ? Q : undefined>
              >,
              RouteResponse<
                  EntryOf<R, C> extends { response: infer S extends Type } ? S : undefined
              >
          >
}

/**
 * Wraps an ArkType schema for query validation: undeclared keys are rejected (422), or removed
 * when the route allows extra keys. Morphs and defaults are kept.
 */
const applyStrictPolicy = <T>(schema: Type<T>, allowExtra: boolean): Type<T> =>
    schema.onUndeclaredKey(allowExtra ? 'delete' : 'reject') as unknown as Type<T>

/**
 * `defineRoute` for a registry: the method and the path come from the contract, the
 * schemas from the registry entry of the contract. Middlewares, limits and body kinds stay
 * settings of the route: the contract says nothing about them.
 */
export function contractRouteDefiner<R extends Readonly<Record<string, SchemaEntry>>>(registry: R) {
    return function defineRoute<C extends AnyContract>(
        config: ContractRouteInput<R, C>,
    ): RouteItem {
        const { contract, ...rest } = config
        const key = keyOf(contract)
        const entry = registry[key]
        if (entry === undefined) {
            throw new Error(`Route contract ${key} has no entry in the schema registry`)
        }

        return {
            ...rest,
            // A multipart contract accepts nothing else: the body kind follows the contract.
            ...(contract.kind === 'multipart' ? { allowedContentTypes: ['multipart'] } : {}),
            url: contract.path,
            method: contract.method,
            contractPath: contract.path,
            validator: entry.body !== undefined ? defaultValidator(entry.body) : undefined,
            queryValidator:
                entry.query !== undefined
                    ? defaultValidator(
                          applyStrictPolicy(entry.query, config.queryAllowExtra === true),
                      )
                    : undefined,
            ResponseSchema: entry.response,
        } as RouteItem
    }
}

type WsContractRouteInput<R, C extends AnyContract> = Omit<
    RouteConfig,
    'url' | 'method' | 'contractPath' | 'validator' | 'queryValidator' | 'ResponseSchema'
> & {
    /** Event, payload and reply: packages/shared/src/contracts/ws.ts. */
    contract: C &
        (KindOf<C> extends 'ws'
            ? ContractKey<C> extends keyof R
                ? unknown
                : ContractMismatch<'the contract has no entry in the schema registry'>
            : ContractMismatch<'a WS route needs a WS contract (wsContract)'>)
    // Without an entry the contract above is already the error; the handler is not checked.
    handler: [EntryOf<R, C>] extends [never]
        ? (...args: never[]) => unknown
        : TypedHandler<
              WsContext<PayloadOf<EntryOf<R, C> extends { body: infer B } ? B : undefined>>,
              RouteResponse<
                  EntryOf<R, C> extends { response: infer S extends Type } ? S : undefined
              >
          >
}

/**
 * `defineWsRoute` for a registry (ADR 0006): the event comes from the contract, the payload and
 * reply schemas from its registry entry. Middlewares and limits stay settings of the route.
 */
export function contractWsRouteDefiner<R extends Readonly<Record<string, SchemaEntry>>>(
    registry: R,
) {
    return function defineWsRoute<C extends AnyContract>(
        config: WsContractRouteInput<R, C>,
    ): RouteItem {
        const { contract, ...rest } = config
        const key = keyOf(contract)
        const entry = registry[key]
        if (contract.kind !== 'ws') {
            throw new Error(`Route contract ${key} is not a WS contract`)
        }
        if (entry === undefined) {
            throw new Error(`Route contract ${key} has no entry in the schema registry`)
        }
        return {
            ...rest,
            url: contract.path,
            method: 'ws',
            contractPath: contract.path,
            validator: entry.body !== undefined ? defaultValidator(entry.body) : undefined,
            ResponseSchema: entry.response,
        } as RouteItem
    }
}
