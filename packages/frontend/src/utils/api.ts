import baseApi from './base-api'
import type { ApiResponse } from './api-error'
import { apiPath } from './api-path'
import { adminQueryString } from './admin-query'
import { callApi } from './api-client'
import type {
    OAuthProvidersResponse,
    OAuthLinkConfirmResponse,
    EmailLinkResendResponse,
    UploadAvatarResponse,
    DeleteAvatarResponse,
    InitResponse,
    LoginResponse,
    ChangePasswordResponse,
    ForgotPasswordResponse,
    LogoutAllResponse,
    LogoutResponse,
    VerifyEmailResponse,
    ResendVerificationEmailResponse,
    ResetPasswordResponse,
    UpdateWsTokenResponse,
    SupportKnowledgeBaseInitJob,
    AdminUserListResponse,
    AdminOnlineUserListResponse,
    AdminOnlineUserDetailResponse,
    AdminOnlineHistoryListResponse,
    RegisterEmailResponse,
    RegisterPhoneStartResponse,
    RegisterPhoneConfirmResponse,
    RegisterPhoneCompleteResponse,
    LinkPhoneStartResponse,
    LinkPhoneConfirmResponse,
    LinkEmailStartResponse,
    ResetPhoneStartResponse,
    ResetPhoneCompleteResponse,
} from 'shared/responses'
import type {
    CreateSubscriptionInput,
    ChangePasswordInput,
    ForgotPasswordInput,
    LoginInput,
    ResetPasswordInput,
    VerifyEmailInput,
    OAuthLinkConfirmInput,
    AdminKnowledgeBaseListQueryInput,
    AdminOnlineHistoryListQueryInput,
    AdminUserListQueryInput,
    PushSubscriptionTestInput,
    RegisterEmailInput,
    RegisterPhoneStartInput,
    RegisterPhoneConfirmInput,
    RegisterPhoneCompleteInput,
    LinkPhoneStartInput,
    LinkPhoneConfirmInput,
    LinkEmailStartInput,
    ResetPhoneStartInput,
    ResetPhoneCompleteInput,
} from 'shared/schemas'
import { adminContracts, authContracts, pushSubscriptionContracts } from 'shared/contracts'
import { getResponseMessage, hasResponseError } from './response-normalizer'

const isSuccessfulResponse = <T extends Record<string, unknown>>(
    response: ApiResponse<T>,
): response is { data: T; error: null } =>
    response.error === null && response.data !== null && !hasResponseError(response.data)

export const authApi = {
    getOAuthProviders: async (): Promise<ApiResponse<OAuthProvidersResponse>> => {
        return baseApi.http<OAuthProvidersResponse>('GET', apiPath('auth/oauth/providers'))
    },

    /**
     * feat-097: the mailed link that confirms an OAuth link. It works only in the browser
     * session that started the sign-in, which is usually still anonymous: `public` recovery.
     */
    confirmOAuthLink: async (
        body: OAuthLinkConfirmInput,
    ): Promise<ApiResponse<OAuthLinkConfirmResponse>> => {
        return baseApi.http<OAuthLinkConfirmResponse>(
            'POST',
            apiPath('auth/oauth/link/confirm'),
            body,
            { csrfRecovery: 'public' },
        )
    },

    /** feat-097: send again the link that confirms the address of an account without one. */
    resendOAuthEmailLink: async (): Promise<ApiResponse<EmailLinkResendResponse>> => {
        return baseApi.http<EmailLinkResendResponse>('POST', apiPath('auth/oauth/email/resend'))
    },

    login: (body: LoginInput): Promise<ApiResponse<LoginResponse>> =>
        callApi(authContracts.login, { body }, { csrfRecovery: 'public' }),

    registerEmail: async (
        body: RegisterEmailInput,
    ): Promise<ApiResponse<RegisterEmailResponse>> => {
        return baseApi.http<RegisterEmailResponse>('POST', apiPath('auth/register/email'), body, {
            csrfRecovery: 'public',
        })
    },

    registerPhoneStart: async (
        body: RegisterPhoneStartInput,
    ): Promise<ApiResponse<RegisterPhoneStartResponse>> => {
        return baseApi.http<RegisterPhoneStartResponse>(
            'POST',
            apiPath('auth/register/phone/start'),
            body,
            { csrfRecovery: 'public' },
        )
    },

    registerPhoneConfirm: async (
        body: RegisterPhoneConfirmInput,
    ): Promise<ApiResponse<RegisterPhoneConfirmResponse>> => {
        return baseApi.http<RegisterPhoneConfirmResponse>(
            'POST',
            apiPath('auth/register/phone/confirm'),
            body,
            { csrfRecovery: 'public' },
        )
    },

    registerPhoneComplete: async (
        body: RegisterPhoneCompleteInput,
    ): Promise<ApiResponse<RegisterPhoneCompleteResponse>> => {
        return baseApi.http<RegisterPhoneCompleteResponse>(
            'POST',
            apiPath('auth/register/phone/complete-profile'),
            body,
            { csrfRecovery: 'public' },
        )
    },

    logout: async (): Promise<ApiResponse<LogoutResponse>> => {
        return baseApi.http<LogoutResponse>(
            'POST',
            apiPath('auth/logout'),
            {},
            { sessionAfter: 'anonymous' },
        )
    },

    logoutAll: async (): Promise<ApiResponse<LogoutAllResponse>> => {
        return baseApi.http<LogoutAllResponse>(
            'POST',
            apiPath('auth/logout-all'),
            {},
            { sessionAfter: 'anonymous' },
        )
    },

    changePassword: async (
        body: ChangePasswordInput,
    ): Promise<ApiResponse<ChangePasswordResponse>> => {
        return baseApi.http<ChangePasswordResponse>('POST', apiPath('auth/change-password'), body)
    },

    forgotPassword: async (
        body: ForgotPasswordInput,
    ): Promise<ApiResponse<ForgotPasswordResponse>> => {
        return baseApi.http<ForgotPasswordResponse>('POST', apiPath('auth/forgot-password'), body, {
            csrfRecovery: 'public',
        })
    },

    startPhonePasswordReset: async (
        body: ResetPhoneStartInput,
    ): Promise<ApiResponse<ResetPhoneStartResponse>> => {
        return baseApi.http<ResetPhoneStartResponse>(
            'POST',
            apiPath('auth/reset-phone/start'),
            body,
            { csrfRecovery: 'public' },
        )
    },

    completePhonePasswordReset: async (
        body: ResetPhoneCompleteInput,
    ): Promise<ApiResponse<ResetPhoneCompleteResponse>> => {
        return baseApi.http<ResetPhoneCompleteResponse>(
            'POST',
            apiPath('auth/reset-phone/complete'),
            body,
            { csrfRecovery: 'public' },
        )
    },

    resetPassword: async (
        body: ResetPasswordInput,
    ): Promise<ApiResponse<ResetPasswordResponse>> => {
        return baseApi.http<ResetPasswordResponse>('POST', apiPath('auth/reset-password'), body, {
            csrfRecovery: 'public',
        })
    },

    verifyEmail: async (body: VerifyEmailInput): Promise<ApiResponse<VerifyEmailResponse>> => {
        return baseApi.http<VerifyEmailResponse>('POST', apiPath('auth/verify-email'), body, {
            csrfRecovery: 'public',
        })
    },

    resendVerificationEmail: async (): Promise<ApiResponse<ResendVerificationEmailResponse>> => {
        return baseApi.http<ResendVerificationEmailResponse>(
            'POST',
            apiPath('auth/resend-verification-email'),
        )
    },

    startPhoneLink: async (
        body: LinkPhoneStartInput,
    ): Promise<ApiResponse<LinkPhoneStartResponse>> => {
        return baseApi.http<LinkPhoneStartResponse>('POST', apiPath('auth/link-phone/start'), body)
    },

    confirmPhoneLink: async (
        body: LinkPhoneConfirmInput,
    ): Promise<ApiResponse<LinkPhoneConfirmResponse>> => {
        return baseApi.http<LinkPhoneConfirmResponse>(
            'POST',
            apiPath('auth/link-phone/confirm'),
            body,
        )
    },

    startEmailLink: async (
        body: LinkEmailStartInput,
    ): Promise<ApiResponse<LinkEmailStartResponse>> => {
        return baseApi.http<LinkEmailStartResponse>('POST', apiPath('auth/link-email/start'), body)
    },
}

export const mainApi = {
    init: async (): Promise<ApiResponse<InitResponse>> => {
        return baseApi.http<InitResponse>('GET', apiPath('main/init'))
    },

    updateWsToken: async (): Promise<ApiResponse<UpdateWsTokenResponse>> => {
        return baseApi.http<UpdateWsTokenResponse>('GET', apiPath('main/update-ws-token'))
    },
}

// The push-subscriptions routes go through their contracts (docs/adr/0005-route-contracts.md):
// the method, the path, the body and the answer of each call are the contract's.
export const pushSubscriptionApi = {
    getSubscriptions: () => callApi(pushSubscriptionContracts.list),

    createSubscription: (body: CreateSubscriptionInput) =>
        callApi(pushSubscriptionContracts.create, { body }),

    getSubscription: (subscriptionId: string) =>
        callApi(pushSubscriptionContracts.get, { params: { subscriptionId } }),

    deleteSubscription: (subscriptionId: string) =>
        callApi(pushSubscriptionContracts.remove, { params: { subscriptionId } }),

    getSubscriptionStatistics: (subscriptionId: string) =>
        callApi(pushSubscriptionContracts.statistics, { params: { subscriptionId } }),

    deactivateSubscription: (subscriptionId: string) =>
        callApi(pushSubscriptionContracts.deactivate, { params: { subscriptionId }, body: {} }),

    getVapidPublicKey: () => callApi(pushSubscriptionContracts.vapidPublicKey),

    testPush: (body: PushSubscriptionTestInput = {}) =>
        callApi(pushSubscriptionContracts.testPush, { body }),
}

export const avatarApi = {
    upload: async (file: Blob): Promise<ApiResponse<UploadAvatarResponse>> => {
        const formData = new FormData()
        formData.append('avatar', file, 'avatar.webp')
        return baseApi.upload<UploadAvatarResponse>('POST', apiPath('avatar/upload'), formData)
    },

    delete: async (): Promise<ApiResponse<DeleteAvatarResponse>> => {
        return baseApi.http<DeleteAvatarResponse>('DELETE', apiPath('avatar'))
    },
}

export interface SupportChatMessage {
    id: string
    role: 'user' | 'assistant'
    content: string
    screenshots: string[] | null
    createdAt: string
}

export interface KnowledgeBaseArticle {
    id: string
    title: string
    content: string
    category: string | null
    isActive: boolean
    hasScreenshot: boolean
    screenshotKey: string | null
    embeddingIndexed: boolean
    createdAt: string
    updatedAt: string
}

export type KnowledgeBaseInitStatus = SupportKnowledgeBaseInitJob

/** One page of the support chat history, oldest-first. */
export interface SupportHistoryPage {
    messages: SupportChatMessage[]
    /** True when there are messages older than the first of `messages`. */
    hasMore: boolean
}

export const supportApi = {
    /**
     * The latest page of the history, or the one before `before` (the id of the oldest
     * message already shown). `null` when it could not be read: an empty page is a real
     * answer (an empty conversation) and must not be confused with a failure.
     */
    getChatHistory: async (
        options: { before?: string; signal?: AbortSignal } = {},
    ): Promise<SupportHistoryPage | null> => {
        const { before, ...requestOptions } = options
        const response = await baseApi.http<{
            status: string
            data?: SupportChatMessage[]
            hasMore?: boolean
        }>(
            'GET',
            apiPath(`support/chat/history${before !== undefined ? `?before=${before}` : ''}`),
            {},
            requestOptions,
        )
        if (!isSuccessfulResponse(response)) return null
        return { messages: response.data.data ?? [], hasMore: response.data.hasMore === true }
    },

    deleteChatHistory: async (): Promise<boolean> => {
        const response = await baseApi.http<{ status: string }>(
            'DELETE',
            apiPath('support/chat/history'),
        )
        return isSuccessfulResponse(response)
    },
}

export const adminKnowledgeBaseApi = {
    getAll: async (
        params?: AdminKnowledgeBaseListQueryInput,
    ): Promise<{ items: KnowledgeBaseArticle[]; total: number }> => {
        const qs = adminQueryString({
            category: params?.category,
            page: params?.page,
            limit: params?.limit,
        })
        const response = await baseApi.http<{
            status: string
            data?: KnowledgeBaseArticle[]
            total?: number
        }>('GET', apiPath(`admin/knowledge-base${qs}`))
        // A failure is not an empty knowledge base: the view must tell them apart.
        if (!isSuccessfulResponse(response)) {
            throw new Error(response.error?.message ?? 'Failed to load the knowledge base')
        }
        return { items: response.data.data ?? [], total: response.data.total ?? 0 }
    },

    create: async (payload: {
        title: string
        content: string
        category?: string
        isActive?: boolean
    }): Promise<KnowledgeBaseArticle | null> => {
        const response = await baseApi.http<{ status: string; data?: KnowledgeBaseArticle }>(
            'POST',
            apiPath('admin/knowledge-base'),
            payload,
        )
        if (!isSuccessfulResponse(response)) return null
        return response.data.data ?? null
    },

    update: async (
        id: string,
        payload: { title?: string; content?: string; category?: string | null; isActive?: boolean },
    ): Promise<KnowledgeBaseArticle | null> => {
        const response = await baseApi.http<{ status: string; data?: KnowledgeBaseArticle }>(
            'PUT',
            apiPath(`admin/knowledge-base/${encodeURIComponent(id)}`),
            payload,
        )
        if (!isSuccessfulResponse(response)) return null
        return response.data.data ?? null
    },

    delete: async (id: string): Promise<boolean> => {
        const response = await baseApi.http<{ status: string }>(
            'DELETE',
            apiPath(`admin/knowledge-base/${encodeURIComponent(id)}`),
        )
        return isSuccessfulResponse(response)
    },

    uploadScreenshot: async (id: string, file: File): Promise<KnowledgeBaseArticle | null> => {
        const formData = new FormData()
        formData.append('screenshot', file)
        const response = await baseApi.upload<{ status: string; data?: KnowledgeBaseArticle }>(
            'POST',
            apiPath(`admin/knowledge-base/${encodeURIComponent(id)}/screenshot`),
            formData,
        )
        if (!isSuccessfulResponse(response)) return null
        return response.data.data ?? null
    },

    deleteScreenshot: async (id: string): Promise<KnowledgeBaseArticle | null> => {
        const response = await baseApi.http<{ status: string; data?: KnowledgeBaseArticle }>(
            'DELETE',
            apiPath(`admin/knowledge-base/${encodeURIComponent(id)}/screenshot`),
        )
        if (!isSuccessfulResponse(response)) return null
        return response.data.data ?? null
    },

    reindex: async (id: string): Promise<boolean> => {
        const response = await baseApi.http<{ status: string }>(
            'POST',
            apiPath(`admin/knowledge-base/${encodeURIComponent(id)}/reindex`),
        )
        return isSuccessfulResponse(response)
    },

    /** `null` when the request failed; `failed` are the ids of the articles left unindexed. */
    reindexAll: async (): Promise<{ indexed: number; failed: string[] } | null> => {
        const response = await baseApi.http<{
            status: string
            indexed?: number
            failed?: string[]
        }>('POST', apiPath('admin/knowledge-base/reindex-all'))
        if (!isSuccessfulResponse(response)) return null
        return { indexed: response.data.indexed ?? 0, failed: response.data.failed ?? [] }
    },

    startInit: async (): Promise<{
        ok: boolean
        status: KnowledgeBaseInitStatus | null
        message: string | null
    }> => {
        const response = await baseApi.http<{
            status: string
            data?: KnowledgeBaseInitStatus
            message?: string
        }>('POST', apiPath('admin/knowledge-base/init'))
        if (!isSuccessfulResponse(response)) {
            return {
                ok: false,
                status: response.data?.data ?? null,
                message: getResponseMessage(
                    response.data,
                    response.error?.message ?? 'Failed to start initialization',
                ),
            }
        }
        return {
            ok: true,
            status: response.data.data ?? null,
            message: null,
        }
    },

    getInitStatus: async (): Promise<KnowledgeBaseInitStatus | null> => {
        const response = await baseApi.http<{ status: string; data?: KnowledgeBaseInitStatus }>(
            'GET',
            apiPath('admin/knowledge-base/init-status'),
        )
        if (!isSuccessfulResponse(response)) return null
        return response.data.data ?? null
    },
}

export const adminUsersApi = {
    list: (params?: AdminUserListQueryInput): Promise<ApiResponse<AdminUserListResponse>> =>
        callApi(adminContracts.users, {
            query: { ...params, userId: params?.userId?.trim() },
        }),
}

export const adminOnlineUsersApi = {
    list: async (): Promise<ApiResponse<AdminOnlineUserListResponse>> => {
        return baseApi.http<AdminOnlineUserListResponse>('GET', apiPath('admin/users-online'))
    },

    getById: async (id: string): Promise<ApiResponse<AdminOnlineUserDetailResponse>> => {
        return baseApi.http<AdminOnlineUserDetailResponse>(
            'GET',
            apiPath(`admin/users-online/${encodeURIComponent(id)}`),
        )
    },
}

export const adminOnlineHistoryApi = {
    list: async (
        params?: AdminOnlineHistoryListQueryInput,
    ): Promise<ApiResponse<AdminOnlineHistoryListResponse>> => {
        const qs = adminQueryString({
            limit: params?.limit,
            cursor: params?.cursor,
            userId: params?.userId?.trim(),
            dateFrom: params?.dateFrom,
            dateTo: params?.dateTo,
        })
        return baseApi.http<AdminOnlineHistoryListResponse>(
            'GET',
            apiPath(`admin/history-online${qs}`),
        )
    },
}
