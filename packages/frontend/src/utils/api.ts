import baseApi from './base-api'
import type { ApiResponse } from './api-error'
import { apiPath } from './api-path'
import type {
    OAuthProvidersResponse,
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
    GetSubscriptionStatisticsResponse,
} from 'shared/responses'
import type {
    CreateSubscriptionInput,
    ChangePasswordInput,
    ForgotPasswordInput,
    LoginInput,
    ResetPasswordInput,
    VerifyEmailInput,
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
import { getResponseMessage, hasResponseError } from './response-normalizer'

const isSuccessfulResponse = <T extends Record<string, unknown>>(
    response: ApiResponse<T>,
): response is { data: T; error: null } =>
    response.error === null && response.data !== null && !hasResponseError(response.data)

export const authApi = {
    getOAuthProviders: async (): Promise<ApiResponse<OAuthProvidersResponse>> => {
        return baseApi.http<OAuthProvidersResponse>('GET', apiPath('auth/oauth/providers'))
    },

    login: async (body: LoginInput): Promise<ApiResponse<LoginResponse>> => {
        return baseApi.http<LoginResponse>('POST', apiPath('auth/login'), body, {
            csrfRecovery: 'public',
        })
    },

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

    register: async (body: RegisterEmailInput): Promise<ApiResponse<RegisterEmailResponse>> => {
        return authApi.registerEmail(body)
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

interface PushSubscriptionData extends Record<string, unknown> {
    endpoint: string
    p256dhKey: string
    authKey: string
    userAgent?: string
    ipAddress?: string
    deviceType?: string
    browserName?: string
    browserVersion?: string
    osName?: string
    osVersion?: string
    notificationTypes?: ('mention' | 'system')[]
    timezone?: string
}

interface PushSubscriptionResponse {
    id: string
    userId: string
    endpoint: string
    p256dhKey: string
    authKey: string
    userAgent?: string
    deviceType?: string
    browserName?: string
    isActive: boolean
    created_at: string
    updated_at: string
}

export const pushSubscriptionApi = {
    getSubscriptions: async (): Promise<ApiResponse<PushSubscriptionResponse[]>> => {
        return baseApi.http<PushSubscriptionResponse[]>('GET', apiPath('push-subscriptions'))
    },

    createSubscription: async (
        subscriptionData: CreateSubscriptionInput | PushSubscriptionData,
    ): Promise<ApiResponse<PushSubscriptionResponse>> => {
        return baseApi.http<PushSubscriptionResponse>(
            'POST',
            apiPath('push-subscriptions'),
            subscriptionData,
        )
    },

    getSubscription: async (
        subscriptionId: string,
    ): Promise<ApiResponse<PushSubscriptionResponse>> => {
        return baseApi.http<PushSubscriptionResponse>(
            'GET',
            apiPath(`push-subscriptions/${subscriptionId}`),
        )
    },

    deleteSubscription: async (
        subscriptionId: string,
    ): Promise<ApiResponse<{ success: boolean }>> => {
        return baseApi.http<{ success: boolean }>(
            'DELETE',
            apiPath(`push-subscriptions/${subscriptionId}`),
        )
    },

    getSubscriptionStatistics: async (
        subscriptionId: string,
    ): Promise<ApiResponse<GetSubscriptionStatisticsResponse>> => {
        return baseApi.http<GetSubscriptionStatisticsResponse>(
            'GET',
            apiPath(`push-subscriptions/${subscriptionId}/statistics`),
        )
    },

    deactivateSubscription: async (
        subscriptionId: string,
    ): Promise<ApiResponse<PushSubscriptionResponse>> => {
        return baseApi.http<PushSubscriptionResponse>(
            'PUT',
            apiPath(`push-subscriptions/${subscriptionId}/deactivate`),
            {},
        )
    },

    getVapidPublicKey: async (): Promise<ApiResponse<{ vapidPublicKey: string }>> => {
        return baseApi.http<{ vapidPublicKey: string }>(
            'GET',
            apiPath('push-subscriptions/vapid-public-key'),
        )
    },

    testPush: async (
        payload: PushSubscriptionTestInput = {},
    ): Promise<
        ApiResponse<{ status: string; message: string; sent?: number; failed?: number }>
    > => {
        return baseApi.http<{ status: string; message: string; sent?: number; failed?: number }>(
            'POST',
            apiPath('push-subscriptions/test-push'),
            payload,
        )
    },
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

    getScreenshotUrl: (articleId: string): string => {
        return apiPath(`support/screenshot/${encodeURIComponent(articleId)}`)
    },
}

export const adminKnowledgeBaseApi = {
    getAll: async (
        params?: AdminKnowledgeBaseListQueryInput,
    ): Promise<{ items: KnowledgeBaseArticle[]; total: number }> => {
        const query = new URLSearchParams()
        if (params?.category) query.set('category', params.category)
        if (params?.page !== undefined) query.set('page', String(params.page))
        if (params?.limit !== undefined) query.set('limit', String(params.limit))
        const qs = query.toString()
        const response = await baseApi.http<{
            status: string
            data?: KnowledgeBaseArticle[]
            total?: number
        }>('GET', apiPath(`admin/knowledge-base${qs ? `?${qs}` : ''}`))
        if (!isSuccessfulResponse(response)) return { items: [], total: 0 }
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

    reindexAll: async (): Promise<number> => {
        const response = await baseApi.http<{ status: string; indexed?: number }>(
            'POST',
            apiPath('admin/knowledge-base/reindex-all'),
        )
        if (!isSuccessfulResponse(response)) return 0
        return response.data.indexed ?? 0
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
    list: async (params?: AdminUserListQueryInput): Promise<ApiResponse<AdminUserListResponse>> => {
        const query = new URLSearchParams()

        if (params?.limit !== undefined) query.set('limit', String(params.limit))
        if (params?.userId !== undefined && params.userId.trim() !== '') {
            query.set('userId', params.userId.trim())
        }
        if (params?.dateFrom !== undefined && params.dateFrom !== '')
            query.set('dateFrom', params.dateFrom)
        if (params?.dateTo !== undefined && params.dateTo !== '') query.set('dateTo', params.dateTo)

        const qs = query.toString()
        return baseApi.http<AdminUserListResponse>(
            'GET',
            apiPath(`admin/users${qs ? `?${qs}` : ''}`),
        )
    },
}

export const adminOnlineUsersApi = {
    list: async (): Promise<ApiResponse<AdminOnlineUserListResponse>> => {
        return baseApi.http<AdminOnlineUserListResponse>('GET', apiPath('admin/users-online'))
    },

    getById: async (id: string): Promise<ApiResponse<AdminOnlineUserDetailResponse>> => {
        return baseApi.http<AdminOnlineUserDetailResponse>(
            'GET',
            apiPath(`admin/users-online/${id}`),
        )
    },
}

export const adminOnlineHistoryApi = {
    list: async (
        params?: AdminOnlineHistoryListQueryInput,
    ): Promise<ApiResponse<AdminOnlineHistoryListResponse>> => {
        const query = new URLSearchParams()

        if (params?.limit !== undefined) query.set('limit', String(params.limit))
        if (params?.cursor !== undefined && params.cursor !== '') query.set('cursor', params.cursor)
        if (params?.userId !== undefined && params.userId.trim() !== '') {
            query.set('userId', params.userId.trim())
        }
        if (params?.dateFrom !== undefined && params.dateFrom !== '')
            query.set('dateFrom', params.dateFrom)
        if (params?.dateTo !== undefined && params.dateTo !== '') query.set('dateTo', params.dateTo)

        const qs = query.toString()
        return baseApi.http<AdminOnlineHistoryListResponse>(
            'GET',
            apiPath(`admin/history-online${qs ? `?${qs}` : ''}`),
        )
    },
}
