import {
    buildUrl,
    type AnyContract,
    type BodyOf,
    type PathOf,
    type PathParams,
    type PathParamNames,
    type QueryOf,
    type ResponseOf,
} from 'shared/contracts'

import baseApi, { type HttpOptions } from './base-api'
import type { ApiResponse } from './api-error'
import { apiPath } from './api-path'

// The typed way to call the API (docs/adr/0005-route-contracts.md). A contract from
// `shared/contracts` names the method, the path and the types of the body, the query and the
// response; `callApi` turns it into a request of the transport in base-api.ts, which keeps doing
// what it did: the CSRF token, the session gate, the one repeat after a token mismatch. The
// contract is `{ method, path }` at run time: no schema comes into the bundle with it.

type ParamsPart<C> = [PathParamNames<PathOf<C>>] extends [never]
    ? { params?: undefined }
    : { params: PathParams<PathOf<C>> }

type QueryPart<C> = [QueryOf<C>] extends [undefined]
    ? { query?: undefined }
    : { query?: QueryOf<C> }

type BodyPart<C> = [BodyOf<C>] extends [undefined] ? { body?: undefined } : { body: BodyOf<C> }

/** What a call of the contract needs: path parameters, a query, a body — those it has. */
export type CallInput<C> = ParamsPart<C> & QueryPart<C> & BodyPart<C>

/** The keys of a type that have to be given. */
type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T]

/** The input may be left out only when nothing in it is required. */
type CallArgs<C> = [RequiredKeys<CallInput<C>>] extends [never]
    ? [input?: CallInput<C>, options?: HttpOptions]
    : [input: CallInput<C>, options?: HttpOptions]

/**
 * Calls the route of a contract.
 *
 *     callApi(pushSubscriptionContracts.remove, { params: { subscriptionId } })
 *     callApi(authContracts.login, { body }, { csrfRecovery: 'public' })
 *
 * `options` are the transport's (`signal`, `csrfRecovery`, `sessionAfter`) and reach it
 * unchanged. A multipart body is not a contract's: uploads keep using `baseApi.upload`.
 */
export const callApi = <C extends AnyContract>(
    contract: C,
    ...[input, options]: CallArgs<C>
): Promise<ApiResponse<ResponseOf<C>>> => {
    const url = apiPath(
        buildUrl(contract, {
            ...(input?.params !== undefined ? { params: input.params } : {}),
            ...(input?.query !== undefined ? { query: input.query } : {}),
        }),
    )
    return baseApi.http<ResponseOf<C>>(
        contract.method.toUpperCase(),
        url,
        input?.body ?? {},
        options,
    )
}
