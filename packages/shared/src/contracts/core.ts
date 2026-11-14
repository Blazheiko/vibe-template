// A route contract: what a client needs to call a route and what both sides agree on.
//
// At run time a contract is `{ method, path }` and nothing else. The types of the body, the
// query and the response ride along as type parameters; the schemas they come from are imported
// with `import type`, so a browser bundle that imports a contract does not get a schema or the
// validator library with it (docs/adr/0005-route-contracts.md).

/** `ws` is a request over the WebSocket (ADR 0006): its path is the event under the prefix. */
export type ContractMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'ws'

/**
 * How a route's request and answer travel (feat-177):
 * - `json` (the default): fetched, a JSON body, a JSON answer;
 * - `multipart`: fetched with a FormData body (fields and files), a JSON answer;
 * - `navigation`: never fetched; the browser goes to its URL (a redirect) or loads it (a file,
 *   an `<img>`). The client only builds its URL;
 * - `ws`: a request over the WebSocket, a JSON payload and a JSON reply (ADR 0006). Its path,
 *   without the API prefix, is the event of the request.
 */
export type ContractKind = 'json' | 'multipart' | 'navigation' | 'ws'

/**
 * What a file is to this package, which declares neither the DOM nor Node: a browser `Blob` or
 * `File` is one.
 */
export interface FileLike {
    readonly size: number
    readonly type: string
}

/** A file of a multipart body: the file, or the file with the name to send it under. */
export type MultipartFile = FileLike | { readonly blob: FileLike; readonly filename: string }

/** The body of a multipart contract: its text fields and its files by field name. */
export interface MultipartBody<TFields, TFile extends string> {
    readonly fields: TFields
    readonly files: Readonly<Record<TFile, MultipartFile>>
}

/** A property that exists only for the type checker. */
declare const contractTypes: unique symbol

export interface RouteContract<
    TMethod extends ContractMethod = ContractMethod,
    TPath extends string = string,
    TBody = undefined,
    TQuery = undefined,
    TResponse = unknown,
    TKind extends ContractKind = 'json',
> {
    /** Absent for `json`. */
    readonly kind?: TKind
    readonly method: TMethod
    /** The path under the API prefix, with `:name` segments: `/push-subscriptions/:subscriptionId`. */
    readonly path: TPath
    /** Never set: it carries the three types. */
    readonly [contractTypes]?: { body: TBody; query: TQuery; response: TResponse }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- "any contract" in constraints */
export type AnyContract = RouteContract<ContractMethod, string, any, any, any, ContractKind>
/* eslint-enable @typescript-eslint/no-explicit-any */

export type BodyOf<C> =
    C extends RouteContract<ContractMethod, string, infer B, unknown, unknown, ContractKind>
        ? B
        : never
export type QueryOf<C> =
    C extends RouteContract<ContractMethod, string, unknown, infer Q, unknown, ContractKind>
        ? Q
        : never
export type ResponseOf<C> =
    C extends RouteContract<ContractMethod, string, unknown, unknown, infer R, ContractKind>
        ? R
        : never
export type PathOf<C> =
    C extends RouteContract<ContractMethod, infer P, unknown, unknown, unknown, ContractKind>
        ? P
        : never
export type KindOf<C> =
    C extends RouteContract<ContractMethod, string, unknown, unknown, unknown, infer K> ? K : never
/** The text fields of a multipart contract: what its body schema checks. */
export type FieldsOf<C> = BodyOf<C> extends MultipartBody<infer F, string> ? F : never

/** The names of the `:name` segments of a path. */
export type PathParamNames<TPath extends string> =
    TPath extends `${string}:${infer Name}/${infer Rest}`
        ? Name | PathParamNames<`/${Rest}`>
        : TPath extends `${string}:${infer Name}`
          ? Name
          : never

/** What a caller passes for the `:name` segments: every one of them, as a string. */
export type PathParams<TPath extends string> = Record<PathParamNames<TPath>, string>

/**
 * Declares a contract. The types come first and the route second, so the method and the path
 * are inferred as literals:
 *
 *     contract<Body, Query, Response>()('post', '/push-subscriptions')
 */
export const contract =
    <TBody = undefined, TQuery = undefined, TResponse = unknown>() =>
    <const TMethod extends ContractMethod, const TPath extends string>(
        method: TMethod,
        path: TPath,
    ): RouteContract<TMethod, TPath, TBody, TQuery, TResponse> => ({ method, path })

/**
 * Declares a multipart contract: text fields of type `TFields`, files under the names `TFile`.
 *
 *     multipartContract<EmptyBody, 'avatar', UploadAvatarResponse>()('post', '/avatar/upload')
 */
export const multipartContract =
    <TFields, TFile extends string, TResponse = unknown>() =>
    <const TMethod extends 'post' | 'put' | 'patch', const TPath extends string>(
        method: TMethod,
        path: TPath,
    ): RouteContract<
        TMethod,
        TPath,
        MultipartBody<TFields, TFile>,
        undefined,
        TResponse,
        'multipart'
    > => ({ kind: 'multipart', method, path })

/**
 * Declares a WebSocket request (ADR 0006): its payload and its reply. The path is the event
 * under the API prefix, as for HTTP:
 *
 *     wsContract<ChatPayload, SupportChatResponse>()('/support/support_chat')
 */
export const wsContract =
    <TPayload = undefined, TResponse = unknown>() =>
    <const TPath extends string>(
        path: TPath,
    ): RouteContract<'ws', TPath, TPayload, undefined, TResponse, 'ws'> => ({
        kind: 'ws',
        method: 'ws',
        path,
    })

/**
 * Declares a GET route the browser navigates to or loads (a redirect, a file): the client builds
 * its URL and never fetches it.
 */
export const navigationContract =
    <TQuery = undefined, TResponse = unknown>() =>
    <const TPath extends string>(
        path: TPath,
    ): RouteContract<'get', TPath, undefined, TQuery, TResponse, 'navigation'> => ({
        kind: 'navigation',
        method: 'get',
        path,
    })

/**
 * The path with its `:name` segments replaced. Every value is percent-encoded, so a value with
 * a slash or a question mark stays one segment. A missing value is a programming error.
 */
export const buildPath = (path: string, params: Readonly<Record<string, string>> = {}): string =>
    path.replace(/:([A-Za-z0-9_]+)/g, (_segment, name: string) => {
        const value = params[name]
        if (value === undefined || value === '') {
            throw new Error(`Route ${path}: no value for the path parameter "${name}"`)
        }
        return encodeURIComponent(value)
    })

export type QueryValue = string | number | boolean | null | undefined
export type QueryInput = Readonly<Record<string, QueryValue | readonly QueryValue[]>>

/**
 * The query string, `?a=1&b=x`, or `''` when nothing is left. `undefined`, `null` and an empty
 * string are left out; an array repeats its key; the keys keep the order they are given in.
 */
export const buildQuery = (query: QueryInput | undefined): string => {
    if (query === undefined) return ''
    // By hand: this package is compiled for both sides and declares neither the DOM nor Node.
    const pairs: string[] = []
    for (const [key, value] of Object.entries(query)) {
        const values = Array.isArray(value)
            ? (value as readonly QueryValue[])
            : [value as QueryValue]
        for (const item of values) {
            if (item === undefined || item === null || item === '') continue
            pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`)
        }
    }
    return pairs.length === 0 ? '' : `?${pairs.join('&')}`
}

/** The path and query of a call: what goes after the API prefix. */
export const buildUrl = (
    route: Pick<AnyContract, 'path'>,
    input: { params?: Readonly<Record<string, string>>; query?: QueryInput } = {},
): string => `${buildPath(route.path, input.params)}${buildQuery(input.query)}`
