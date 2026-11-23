import type { ApiResponse } from './api-error'
import type { Role } from 'shared/access'
import { callApi } from './api-client'
import type {
    OAuthProvidersResponse,
    OAuthLinkConfirmResponse,
    EmailLinkResendResponse,
    UploadAvatarResponse,
    DeleteAvatarResponse,
    InitResponse,
    LoginResponse,
    MfaStateResponse,
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
    AdminAuditEventsResponse,
    RegisterEmailResponse,
    RegisterPhoneStartResponse,
    RegisterPhoneConfirmResponse,
    RegisterPhoneCompleteResponse,
    LinkPhoneStartResponse,
    LinkPhoneConfirmResponse,
    LinkEmailStartResponse,
    ResetPhoneStartResponse,
    ResetPhoneCompleteResponse,
    GetSignInMethodsResponse,
    UnlinkSignInMethodResponse,
    MfaStatusResponse,
    RecoveryCodesResponse,
    ReauthOptionsResponse,
    ReauthResponse,
    TotpConfirmResponse,
    TotpDisableResponse,
    TotpSetupResponse,
    PasskeyChallengeResponse,
    PasskeyDeleteResponse,
    PasskeyListResponse,
    PasskeyLoginOptionsResponse,
    PasskeyOptionsResponse,
    PasskeyRegisterResponse,
    PasskeyRenameResponse,
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
    AdminAuditEventsQueryInput,
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
    UpdateProfileInput,
    UpdateNotificationPreferenceInput,
    MfaVerifyInput,
    ReauthInput,
    TotpConfirmInput,
    PasskeyLoginInput,
    PasskeyRegisterInput,
} from 'shared/schemas'
import {
    accountContracts,
    adminContracts,
    authContracts,
    avatarContracts,
    knowledgeBaseContracts,
    mainContracts,
    notificationContracts,
    oauthContracts,
    pushSubscriptionContracts,
    supportContracts,
    mfaContracts,
    passkeyContracts,
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
        callApi(oauthContracts.resendEmailLink, { body: {} }),

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
        // feat-233: it renews this session; a 401 of a request sent from the old one is stale.
        callApi(authContracts.changePassword, { body }, { renewsSession: true }),

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

    // feat-199: the OAuth identities linked to the account.
    signInMethods: (): Promise<ApiResponse<GetSignInMethodsResponse>> =>
        callApi(authContracts.signInMethods, {}),

    unlinkSignInMethod: (body: { id: string }): Promise<ApiResponse<UnlinkSignInMethodResponse>> =>
        callApi(authContracts.unlinkSignInMethod, { body }),

    // feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the second sign-in step. The ticket travels
    // in an HttpOnly cookie; the session is still anonymous, so `public` recovery.
    mfaVerify: (body: MfaVerifyInput): Promise<ApiResponse<LoginResponse>> =>
        callApi(authContracts.mfaVerify, { body }, { csrfRecovery: 'public' }),

    // feat-245 (Р4): whether this browser holds a second step a reload took out of memory.
    mfaState: (): Promise<ApiResponse<MfaStateResponse>> =>
        callApi(authContracts.mfaState, { body: {} }, { csrfRecovery: 'public' }),

    // feat-246 (Р6): a passkey as the second step (its challenge is bound to the ticket cookie).
    mfaWebauthnOptions: (): Promise<ApiResponse<PasskeyChallengeResponse>> =>
        callApi(authContracts.mfaWebauthnOptions, { body: {} }, { csrfRecovery: 'public' }),

    // feat-246 (Р6): a sign-in with a passkey alone.
    passkeyOptions: (): Promise<ApiResponse<PasskeyLoginOptionsResponse>> =>
        callApi(authContracts.passkeyOptions, { body: {} }, { csrfRecovery: 'public' }),
    passkeyVerify: (body: PasskeyLoginInput): Promise<ApiResponse<LoginResponse>> =>
        callApi(authContracts.passkeyVerify, { body }, { csrfRecovery: 'public' }),

    // feat-246 (Р6): the options of a passkey step-up of this session.
    reauthWebauthnOptions: (): Promise<ApiResponse<PasskeyChallengeResponse>> =>
        callApi(authContracts.reauthWebauthnOptions, { body: {} }),

    // feat-245 (Р3): the proofs this session can give, and a step-up.
    reauthOptions: (): Promise<ApiResponse<ReauthOptionsResponse>> =>
        callApi(authContracts.reauthOptions, { body: {} }),
    reauth: (body: ReauthInput): Promise<ApiResponse<ReauthResponse>> =>
        callApi(authContracts.reauth, { body }),

    // feat-245 (Р8): ends a recovery session; an ordinary sign-in follows.
    recoveryFinish: (): Promise<ApiResponse<LogoutResponse>> =>
        callApi(authContracts.recoveryFinish, { body: {} }, { sessionAfter: 'anonymous' }),
}

// feat-245 (Р7, Р8): the second factors of the signed-in account.
export const mfaApi = {
    status: (): Promise<ApiResponse<MfaStatusResponse>> => callApi(mfaContracts.status),
    totpSetup: (): Promise<ApiResponse<TotpSetupResponse>> =>
        callApi(mfaContracts.totpSetup, { body: {} }),
    totpConfirm: (body: TotpConfirmInput): Promise<ApiResponse<TotpConfirmResponse>> =>
        callApi(mfaContracts.totpConfirm, { body }),
    totpDisable: (): Promise<ApiResponse<TotpDisableResponse>> => callApi(mfaContracts.totpDisable),
    regenerateRecoveryCodes: (): Promise<ApiResponse<RecoveryCodesResponse>> =>
        callApi(mfaContracts.regenerateRecoveryCodes, { body: {} }),
}

// feat-246 (Р6): the passkeys of the signed-in account.
export const passkeyApi = {
    list: (): Promise<ApiResponse<PasskeyListResponse>> => callApi(passkeyContracts.list),
    registerOptions: (): Promise<ApiResponse<PasskeyOptionsResponse>> =>
        callApi(passkeyContracts.registerOptions, { body: {} }),
    register: (body: PasskeyRegisterInput): Promise<ApiResponse<PasskeyRegisterResponse>> =>
        callApi(passkeyContracts.register, { body }),
    rename: (id: string, name: string): Promise<ApiResponse<PasskeyRenameResponse>> =>
        callApi(passkeyContracts.rename, { params: { id }, body: { name } }),
    remove: (id: string): Promise<ApiResponse<PasskeyDeleteResponse>> =>
        callApi(passkeyContracts.remove, { params: { id } }),
}

// feat-232: the profile of the signed-in user. Absent field unchanged, `null` resets.
export const accountApi = {
    getProfile: () => callApi(accountContracts.getProfile),
    // feat-240 (Р8): the current role, read again on reconnect and when the tab is shown.
    getAccess: () => callApi(accountContracts.getAccess),
    updateProfile: (body: UpdateProfileInput) => callApi(accountContracts.updateProfile, { body }),
    // feat-233: the active sessions of the account.
    listSessions: (cursor?: string) =>
        callApi(accountContracts.listSessions, cursor === undefined ? {} : { query: { cursor } }),
    revokeSession: (id: string) => callApi(accountContracts.revokeSession, { params: { id } }),
    revokeOtherSessions: () =>
        callApi(accountContracts.revokeOtherSessions, { body: {} }, { renewsSession: true }),
}

// feat-236: the notification center (Р4, Р6).
export const notificationsApi = {
    list: (query: { unread?: boolean; before?: string; limit?: number } = {}) =>
        callApi(notificationContracts.list, {
            query: {
                ...(query.unread === true ? { unread: '1' as const } : {}),
                ...(query.before !== undefined ? { before: query.before } : {}),
                ...(query.limit !== undefined ? { limit: query.limit } : {}),
            },
        }),
    unreadCount: () => callApi(notificationContracts.unreadCount),
    markRead: (id: string) => callApi(notificationContracts.markRead, { params: { id }, body: {} }),
    readAll: (upTo: string) => callApi(notificationContracts.readAll, { body: { upTo } }),
    getPreferences: () => callApi(notificationContracts.getPreferences),
    updatePreference: (body: UpdateNotificationPreferenceInput) =>
        callApi(notificationContracts.updatePreference, { body }),
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
    // feat-241: changes the role of a user; the server applies the delegation policy.
    setRole: (id: string, role: Role) =>
        callApi(adminContracts.setUserRole, { params: { id }, body: { role } }),
    // feat-247: resets the second factors of another account (users.mfa.reset).
    resetMfa: (id: string, reason: string) =>
        callApi(adminContracts.resetUserMfa, { params: { id }, body: { reason } }),
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

// feat-235 (Р7, Р10): the audit log, newest first; `cursor` is the `nextCursor` of the page shown.
export const adminAuditEventsApi = {
    list: (query: AdminAuditEventsQueryInput): Promise<ApiResponse<AdminAuditEventsResponse>> =>
        callApi(adminContracts.auditEvents, { query }),
}
