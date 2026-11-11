import type { ApiResponse } from './api-error'
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
    SupportKnowledgeBaseItem,
    SupportChatHistoryItem,
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
    SupportKnowledgeBaseCreateInput,
    SupportKnowledgeBaseUpdateInput,
} from 'shared/schemas'
import {
    adminContracts,
    authContracts,
    avatarContracts,
    knowledgeBaseContracts,
    mainContracts,
    oauthContracts,
    pushSubscriptionContracts,
    supportContracts,
} from 'shared/contracts'
import { getResponseMessage, hasResponseError } from './response-normalizer'

const isSuccessfulResponse = <T extends Record<string, unknown>>(
    response: ApiResponse<T>,
): response is { data: Exclude<T, { status: 'error' }>; error: null } =>
    response.error === null && response.data !== null && !hasResponseError(response.data)

export const authApi = {
    getOAuthProviders: (): Promise<ApiResponse<OAuthProvidersResponse>> =>
        callApi(oauthContracts.providers),

    /**
     * feat-097: the mailed link that confirms an OAuth link. It works only in the browser
     * session that started the sign-in, which is usually still anonymous: `public` recovery.
     */
    confirmOAuthLink: (
        body: OAuthLinkConfirmInput,
    ): Promise<ApiResponse<OAuthLinkConfirmResponse>> =>
        callApi(oauthContracts.confirmLink, { body }, { csrfRecovery: 'public' }),

    /** feat-097: send again the link that confirms the address of an account without one. */
    resendOAuthEmailLink: (): Promise<ApiResponse<EmailLinkResendResponse>> =>
        callApi(oauthContracts.resendEmailLink),

    login: (body: LoginInput): Promise<ApiResponse<LoginResponse>> =>
        callApi(authContracts.login, { body }, { csrfRecovery: 'public' }),

    registerEmail: (body: RegisterEmailInput): Promise<ApiResponse<RegisterEmailResponse>> =>
        callApi(authContracts.registerEmail, { body }, { csrfRecovery: 'public' }),

    registerPhoneStart: (
        body: RegisterPhoneStartInput,
    ): Promise<ApiResponse<RegisterPhoneStartResponse>> =>
        callApi(authContracts.registerPhoneStart, { body }, { csrfRecovery: 'public' }),

    registerPhoneConfirm: (
        body: RegisterPhoneConfirmInput,
    ): Promise<ApiResponse<RegisterPhoneConfirmResponse>> =>
        callApi(authContracts.registerPhoneConfirm, { body }, { csrfRecovery: 'public' }),

    registerPhoneComplete: (
        body: RegisterPhoneCompleteInput,
    ): Promise<ApiResponse<RegisterPhoneCompleteResponse>> =>
        callApi(authContracts.registerPhoneComplete, { body }, { csrfRecovery: 'public' }),

    logout: (): Promise<ApiResponse<LogoutResponse>> =>
        callApi(authContracts.logout, { body: {} }, { sessionAfter: 'anonymous' }),

    logoutAll: (): Promise<ApiResponse<LogoutAllResponse>> =>
        callApi(authContracts.logoutAll, { body: {} }, { sessionAfter: 'anonymous' }),

    changePassword: (body: ChangePasswordInput): Promise<ApiResponse<ChangePasswordResponse>> =>
        callApi(authContracts.changePassword, { body }),

    forgotPassword: (body: ForgotPasswordInput): Promise<ApiResponse<ForgotPasswordResponse>> =>
        callApi(authContracts.forgotPassword, { body }, { csrfRecovery: 'public' }),

    startPhonePasswordReset: (
        body: ResetPhoneStartInput,
    ): Promise<ApiResponse<ResetPhoneStartResponse>> =>
        callApi(authContracts.resetPhoneStart, { body }, { csrfRecovery: 'public' }),

    completePhonePasswordReset: (
        body: ResetPhoneCompleteInput,
    ): Promise<ApiResponse<ResetPhoneCompleteResponse>> =>
        callApi(authContracts.resetPhoneComplete, { body }, { csrfRecovery: 'public' }),

    resetPassword: (body: ResetPasswordInput): Promise<ApiResponse<ResetPasswordResponse>> =>
        callApi(authContracts.resetPassword, { body }, { csrfRecovery: 'public' }),

    verifyEmail: (body: VerifyEmailInput): Promise<ApiResponse<VerifyEmailResponse>> =>
        callApi(authContracts.verifyEmail, { body }, { csrfRecovery: 'public' }),

    resendVerificationEmail: (): Promise<ApiResponse<ResendVerificationEmailResponse>> =>
        callApi(authContracts.resendVerificationEmail, { body: {} }),

    startPhoneLink: (body: LinkPhoneStartInput): Promise<ApiResponse<LinkPhoneStartResponse>> =>
        callApi(authContracts.linkPhoneStart, { body }),

    confirmPhoneLink: (
        body: LinkPhoneConfirmInput,
    ): Promise<ApiResponse<LinkPhoneConfirmResponse>> =>
        callApi(authContracts.linkPhoneConfirm, { body }),

    startEmailLink: (body: LinkEmailStartInput): Promise<ApiResponse<LinkEmailStartResponse>> =>
        callApi(authContracts.linkEmailStart, { body }),
}

export const mainApi = {
    init: (): Promise<ApiResponse<InitResponse>> => callApi(mainContracts.init),

    updateWsToken: (): Promise<ApiResponse<UpdateWsTokenResponse>> =>
        callApi(mainContracts.updateWsToken),
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
    upload: (file: Blob): Promise<ApiResponse<UploadAvatarResponse>> =>
        callApi(avatarContracts.upload, {
            body: { fields: {}, files: { avatar: { blob: file, filename: 'avatar.webp' } } },
        }),

    delete: (): Promise<ApiResponse<DeleteAvatarResponse>> => callApi(avatarContracts.remove),
}

export type SupportChatMessage = SupportChatHistoryItem

export type KnowledgeBaseArticle = SupportKnowledgeBaseItem

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
        const response = await callApi(
            supportContracts.history,
            { query: { before } },
            requestOptions,
        )
        if (!isSuccessfulResponse(response)) return null
        return { messages: response.data.data ?? [], hasMore: response.data.hasMore === true }
    },

    deleteChatHistory: async (): Promise<boolean> => {
        const response = await callApi(supportContracts.deleteHistory)
        return isSuccessfulResponse(response)
    },
}

export const adminKnowledgeBaseApi = {
    getAll: async (
        params?: AdminKnowledgeBaseListQueryInput,
    ): Promise<{ items: KnowledgeBaseArticle[]; total: number }> => {
        const response = await callApi(knowledgeBaseContracts.list, {
            query: { category: params?.category, page: params?.page, limit: params?.limit },
        })
        // A failure is not an empty knowledge base: the view must tell them apart.
        if (!isSuccessfulResponse(response)) {
            throw new Error(response.error?.message ?? 'Failed to load the knowledge base')
        }
        return { items: response.data.data ?? [], total: response.data.total ?? 0 }
    },

    create: async (
        payload: SupportKnowledgeBaseCreateInput,
    ): Promise<KnowledgeBaseArticle | null> => {
        const response = await callApi(knowledgeBaseContracts.create, { body: payload })
        if (!isSuccessfulResponse(response)) return null
        return response.data.data ?? null
    },

    update: async (
        id: string,
        payload: SupportKnowledgeBaseUpdateInput,
    ): Promise<KnowledgeBaseArticle | null> => {
        const response = await callApi(knowledgeBaseContracts.update, {
            params: { id },
            body: payload,
        })
        if (!isSuccessfulResponse(response)) return null
        return response.data.data ?? null
    },

    delete: async (id: string): Promise<boolean> => {
        const response = await callApi(knowledgeBaseContracts.remove, { params: { id } })
        return isSuccessfulResponse(response)
    },

    uploadScreenshot: async (id: string, file: File): Promise<KnowledgeBaseArticle | null> => {
        const response = await callApi(knowledgeBaseContracts.uploadScreenshot, {
            params: { id },
            body: { fields: {}, files: { screenshot: file } },
        })
        if (!isSuccessfulResponse(response)) return null
        return response.data.data ?? null
    },

    deleteScreenshot: async (id: string): Promise<KnowledgeBaseArticle | null> => {
        const response = await callApi(knowledgeBaseContracts.removeScreenshot, { params: { id } })
        if (!isSuccessfulResponse(response)) return null
        return response.data.data ?? null
    },

    reindex: async (id: string): Promise<boolean> => {
        const response = await callApi(knowledgeBaseContracts.reindex, {
            params: { id },
            body: {},
        })
        return isSuccessfulResponse(response)
    },

    /** `null` when the request failed; `failed` are the ids of the articles left unindexed. */
    reindexAll: async (): Promise<{ indexed: number; failed: string[] } | null> => {
        const response = await callApi(knowledgeBaseContracts.reindexAll, { body: {} })
        if (!isSuccessfulResponse(response)) return null
        return { indexed: response.data.indexed ?? 0, failed: response.data.failed ?? [] }
    },

    startInit: async (): Promise<{
        ok: boolean
        status: KnowledgeBaseInitStatus | null
        message: string | null
    }> => {
        const response = await callApi(knowledgeBaseContracts.startInit, { body: {} })
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
        const response = await callApi(knowledgeBaseContracts.initStatus)
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
    list: (): Promise<ApiResponse<AdminOnlineUserListResponse>> =>
        callApi(adminContracts.onlineUsers),

    getById: (id: string): Promise<ApiResponse<AdminOnlineUserDetailResponse>> =>
        callApi(adminContracts.onlineUser, { params: { id } }),
}

export const adminOnlineHistoryApi = {
    list: (
        params?: AdminOnlineHistoryListQueryInput,
    ): Promise<ApiResponse<AdminOnlineHistoryListResponse>> =>
        callApi(adminContracts.onlineHistory, {
            query: { ...params, userId: params?.userId?.trim() },
        }),
}
