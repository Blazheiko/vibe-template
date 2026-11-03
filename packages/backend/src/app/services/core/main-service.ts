import type { HttpData, ResponseData, SessionInfo } from '#vendor/types/types.js'
import { userRepository } from '#app/repositories/index.js'
import { generateWsToken } from '#app/services/auth/generate-ws-token-service.js'
import { getWsUrl } from '#app/services/communication/get-ws-url-service.js'
import diskConfig from '#config/disk.js'
import appConfig from '#config/app.js'
import { Result } from 'better-result'
import { notFound, unauthorized, type AppResult } from '#app/services/shared/errors.js'
import { getSessionCsrfToken } from '#vendor/utils/session/csrf-token.js'

interface StorageConfigPayload {
    cdnUrl: string
    s3Prefix: string
    s3StaticDataPrefix: string
    s3DynamicDataPrefix: string
}

interface InitUserPayload {
    id: string
    name: string
    email: string
    phone: string | null
    emailVerified: boolean
    emailVerifiedAt: string | null
    avatar: string | null
    role: 'user' | 'admin'
    createdAt: string
    updatedAt: string
}

export const mainService = {
    ping(): { status: 'ok' } {
        return { status: 'ok' }
    },

    testHeaders(httpData: HttpData): {
        status: 'ok'
        headers: { key: string; value: string }[]
        params: unknown[]
    } {
        const headers: { key: string; value: string }[] = []
        const params: unknown[] = Object.entries(httpData.params)

        // Never echo headers that carry secrets back to the client. `cookie` is
        // already excluded from httpData.headers, but `authorization` is kept there
        // (handlers may read it) — so redact here.
        const SENSITIVE_HEADERS = new Set(['cookie', 'authorization'])
        httpData.headers.forEach((value, key) => {
            if (SENSITIVE_HEADERS.has(key)) return
            headers.push({ key, value })
        })

        return { status: 'ok', headers, params }
    },

    getSetCookies(httpData: HttpData): {
        status: 'ok'
        cookies: { key: string; value: string }[]
    } {
        const cookies: { key: string; value: string }[] = []
        httpData.cookies.forEach((value, key) => {
            cookies.push({ key, value })
        })
        return { status: 'ok', cookies }
    },

    testSession(
        httpData: HttpData,
        sessionInfo: SessionInfo | null,
    ): {
        status: 'ok'
        cookies: { key: string; value: string }[]
        sessionInfo: SessionInfo | null
    } {
        const cookies: { key: string; value: string }[] = []
        httpData.cookies.forEach((value, key) => {
            cookies.push({ key, value })
        })
        return { status: 'ok', cookies, sessionInfo }
    },

    async updateWsToken(sessionInfo: SessionInfo | null): Promise<
        AppResult<{
            wsUrl: string
            wsToken: string
        }>
    > {
        if (sessionInfo === null) {
            return Result.err(unauthorized('Session not found'))
        }

        const userId = sessionInfo.data.userId
        if (userId === undefined || userId === '') {
            return Result.err(unauthorized('Session expired'))
        }

        const wsToken = await generateWsToken(sessionInfo, userId)
        return Result.ok({
            wsUrl: wsToken !== '' ? getWsUrl() : '',
            wsToken,
        })
    },

    async init(sessionInfo: SessionInfo | null): Promise<
        AppResult<{
            csrfToken?: string
            user: InitUserPayload
            wsUrl: string
            wsToken: string
            storage: StorageConfigPayload
        }>
    > {
        if (sessionInfo === null) {
            return Result.err(notFound('Session', 'Session not found'))
        }

        const userId = sessionInfo.data.userId
        if (userId === undefined || userId === '') {
            return Result.err(unauthorized('Session expired'))
        }

        const user = await userRepository.findById(BigInt(userId))
        if (user === undefined) {
            return Result.err(unauthorized('Session expired'))
        }

        const wsToken = await generateWsToken(sessionInfo, String(user.id))

        const csrfToken = getSessionCsrfToken(sessionInfo)
        return Result.ok({
            ...(csrfToken !== undefined ? { csrfToken } : {}),
            user: {
                id: String(user.id),
                name: user.name,
                email: user.email ?? '',
                phone: user.phone ?? null,
                emailVerified: user.emailVerifiedAt !== null,
                emailVerifiedAt:
                    user.emailVerifiedAt === null ? null : user.emailVerifiedAt.toISOString(),
                avatar: user.avatar ?? null,
                role: user.role,
                createdAt: user.createdAt.toISOString(),
                updatedAt: user.updatedAt.toISOString(),
            },
            wsUrl: wsToken !== '' ? getWsUrl() : '',
            wsToken,
            storage: {
                cdnUrl: appConfig.cdnUrl,
                s3Prefix: diskConfig.s3Prefix ?? '',
                s3StaticDataPrefix: diskConfig.s3StaticDataPrefix ?? '',
                s3DynamicDataPrefix: diskConfig.s3DynamicDataPrefix ?? '',
            },
        })
    },

    setHeaderAndCookie(responseData: ResponseData): { status: 'ok' } {
        responseData.headers.push({ name: 'test-header', value: 'test' })
        responseData.setCookie({
            name: 'cookieTest1',
            value: 'test',
            path: '/',
            httpOnly: true,
            secure: false,
            maxAge: 3600,
            expires: undefined,
            sameSite: undefined,
        })
        responseData.setCookie('cookieTest2', 'test')
        return { status: 'ok' }
    },

    testMiddleware(responseData: ResponseData): {
        middlewares: string[]
        status: 'ok'
    } {
        return {
            middlewares: responseData.middlewareData as unknown as string[],
            status: 'ok',
        }
    },
}
