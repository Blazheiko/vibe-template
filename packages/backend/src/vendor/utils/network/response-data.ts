import cookiesConfig from '#config/cookies.js'
import type { Cookie, CookieOptions, Header, ResponseData } from '#vendor/types/types.js'

/**
 * Shared response-data builder for both the HTTP server (`server.ts`)
 * and the static page server (`static-server.ts`).
 *
 * Keeping this in one place avoids subtle drift between the two cookie
 * lifecycles (set / delete) — previously they were duplicated inline.
 */
export const createResponseData = (): ResponseData => {
    const cookies: Map<string, Cookie> = new Map<string, Cookie>()
    const headers: Header[] = []

    const setCookie: ResponseData['setCookie'] = (
        nameOrCookie: string | Cookie,
        value?: string,
        options?: CookieOptions,
    ): void => {
        if (typeof nameOrCookie === 'string') {
            cookies.set(nameOrCookie, {
                name: nameOrCookie,
                value: value ?? '',
                path: options?.path ?? cookiesConfig.default.path,
                httpOnly: options?.httpOnly ?? cookiesConfig.default.httpOnly,
                secure: options?.secure ?? cookiesConfig.default.secure,
                expires: options?.expires ?? undefined,
                maxAge: options?.maxAge ?? cookiesConfig.default.maxAge,
                sameSite: options?.sameSite ?? cookiesConfig.default.sameSite,
            })
            return
        }

        cookies.set(nameOrCookie.name, nameOrCookie)
    }

    /**
     * Emits a real `Set-Cookie` tombstone (`Max-Age=0`, empty value) so the
     * browser drops the cookie. The caller MUST pass a `path` that matches the
     * original cookie's `Path` for deletion to succeed (RFC 6265 §4.1.1).
     * Defaults: `path` and `secure`/`sameSite` come from `cookiesConfig.default`.
     */
    const deleteCookie: ResponseData['deleteCookie'] = (
        name: string,
        options?: { path?: string; secure?: boolean; sameSite?: string },
    ): void => {
        cookies.set(name, {
            name,
            value: '',
            path: options?.path ?? cookiesConfig.default.path,
            httpOnly: undefined,
            secure: options?.secure ?? cookiesConfig.default.secure,
            maxAge: 0,
            expires: new Date(0),
            sameSite: options?.sameSite ?? cookiesConfig.default.sameSite,
        })
    }

    // feat-275: sets, does not append. A second call with the same name (any case) replaces
    // the value and keeps the first spelling and position. Cookies go through setCookie.
    const setHeader: ResponseData['setHeader'] = (name: string, value: string): void => {
        const lower = name.toLowerCase()
        const existing = headers.find((header) => header.name.toLowerCase() === lower)
        if (existing !== undefined) existing.value = value
        else headers.push({ name, value })
    }

    return {
        aborted: false,
        payload: {},
        middlewareData: {},
        headers,
        cookies,
        status: 200,
        setCookie,
        deleteCookie,
        setHeader,
    }
}
