import { type } from '@arktype/type'
import { RoleSchema } from '../access/index.js'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'
import { ProfilePreferencesSchema, ProfileRevisionSchema } from './account-controller.js'

export const PingResponseSchema = type({
    status: "'ok'",
})
export type PingResponse = typeof PingResponseSchema.infer

// GET /ready: 200 with "ok", 503 with "unavailable"; never names the failed dependency.
export const ReadyResponseSchema = type({
    status: "'ok' | 'unavailable'",
})
export type ReadyResponse = typeof ReadyResponseSchema.infer

export const TestRouteResponseSchema = type({
    status: 'string',
})
export type TestRouteResponse = typeof TestRouteResponseSchema.infer

export const InitResponseSchema = type.or(
    {
        status: "'ok'",
        'csrfToken?': 'string',
        'user?': {
            id: 'string',
            name: 'string',
            email: 'string',
            'phone?': 'string | null',
            emailVerified: 'boolean',
            'emailVerifiedAt?': 'string | null',
            'avatar?': 'string | null',
            'role?': RoleSchema,
            createdAt: 'string',
            updatedAt: 'string',
            // The profile preferences and their revision (feat-232, Р6): the same values as
            // GET /account/profile, so the client applies them right after init.
            preferences: ProfilePreferencesSchema,
            revision: ProfileRevisionSchema,
        },
        'wsUrl?': 'string',
        'wsToken?': 'string',
        'storage?': {
            'cdnUrl?': 'string',
            's3Prefix?': 'string',
            's3StaticDataPrefix?': 'string',
            's3DynamicDataPrefix?': 'string',
        },
    },
    CanonicalErrorResponseSchema,
)
export type InitResponse = WithCanonicalError<typeof InitResponseSchema.infer>

export const TestApiSessionResponseSchema = type({
    status: 'string',
    headers: 'unknown[]',
    sessionInfo: 'unknown',
})
export type TestApiSessionResponse = typeof TestApiSessionResponseSchema.infer

export const IndexResponseSchema = type({
    payload: 'unknown',
    responseData: 'unknown',
})
export type IndexResponse = typeof IndexResponseSchema.infer

export const TestParamsResponseSchema = type({
    params: 'unknown',
    query: 'string[]',
    status: 'string',
})
export type TestParamsResponse = typeof TestParamsResponseSchema.infer

export const SetHeaderAndCookieResponseSchema = type({
    status: 'string',
})
export type SetHeaderAndCookieResponse = typeof SetHeaderAndCookieResponseSchema.infer

export const TestMiddlewareResponseSchema = type({
    middlewares: 'string[]',
    status: 'string',
})
export type TestMiddlewareResponse = typeof TestMiddlewareResponseSchema.infer

export const UpdateWsTokenResponseSchema = type.or(
    {
        status: "'ok'",
        'wsUrl?': 'string',
        'wsToken?': 'string',
    },
    CanonicalErrorResponseSchema,
)
export type UpdateWsTokenResponse = WithCanonicalError<typeof UpdateWsTokenResponseSchema.infer>
