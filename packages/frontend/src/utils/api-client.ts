import {
    buildUrl,
    type AnyContract,
    type BodyOf,
    type KindOf,
    type MultipartBody,
    type MultipartFile,
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
type InputArgs<C, TRest extends unknown[]> = [RequiredKeys<CallInput<C>>] extends [never]
    ? [input?: CallInput<C>, ...rest: TRest]
    : [input: CallInput<C>, ...rest: TRest]

/** A navigation contract is never fetched: `callApi` does not accept one (see `contractUrl`). */
type CallArgs<C> =
    KindOf<C> extends 'navigation'
        ? [input: never, options?: never]
        : InputArgs<C, [options?: HttpOptions]>

const toFormData = (body: MultipartBody<Record<string, unknown>, string>): FormData => {
    const form = new FormData()
    for (const [name, value] of Object.entries(body.fields)) {
        if (value === undefined || value === null) continue
        form.append(name, typeof value === 'string' ? value : JSON.stringify(value))
    }
    for (const [name, file] of Object.entries<MultipartFile>(body.files)) {
        if ('blob' in file) form.append(name, file.blob as Blob, file.filename)
        else form.append(name, file as Blob)
    }
    return form
}

/**
 * Calls the route of a contract.
 *
 *     callApi(pushSubscriptionContracts.remove, { params: { subscriptionId } })
 *     callApi(authContracts.login, { body }, { csrfRecovery: 'public' })
 *     callApi(avatarContracts.upload, { body: { fields: {}, files: { avatar: blob } } })
 *
 * `options` are the transport's (`signal`, `csrfRecovery`, `sessionAfter`) and reach it
 * unchanged. A multipart contract sends a FormData through `baseApi.upload`, with the same CSRF
 * token and session gate as a JSON call.
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
    if (contract.kind === 'multipart') {
        return baseApi.upload<ResponseOf<C>>(
            contract.method.toUpperCase(),
            url,
            toFormData(input?.body as MultipartBody<Record<string, unknown>, string>),
            options,
        )
    }
    return baseApi.http<ResponseOf<C>>(
        contract.method.toUpperCase(),
        url,
        input?.body ?? {},
        options,
    )
}

type UrlInput<C> = ParamsPart<C> & QueryPart<C>

/**
 * The URL of a navigation contract: what an `<a href>`, a `location.assign` or an `<img src>`
 * gets. The browser follows it; nothing here fetches it.
 *
 *     contractUrl(oauthContracts.redirect, { params: { provider } })
 */
export const contractUrl = <C extends AnyContract>(
    contract: C & (KindOf<C> extends 'navigation' ? unknown : { readonly kind: 'navigation' }),
    ...[input]: [RequiredKeys<UrlInput<C>>] extends [never]
        ? [input?: UrlInput<C>]
        : [input: UrlInput<C>]
): string =>
    apiPath(
        buildUrl(contract, {
            ...(input?.params !== undefined ? { params: input.params } : {}),
            ...(input?.query !== undefined ? { query: input.query } : {}),
        }),
    )
