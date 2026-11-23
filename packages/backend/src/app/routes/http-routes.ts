import MainController from '#app/controllers/http/core/main-controller.js'
import AuthController from '#app/controllers/http/auth/auth-controller.js'
import SignInMethodsController from '#app/controllers/http/auth/sign-in-methods-controller.js'
import AdminUserController from '#app/controllers/http/admin/admin-user-controller.js'
import AdminAuditEventsController from '#app/controllers/http/admin/admin-audit-events-controller.js'
import { AUDIT_EVENTS_QUERY_ARRAYS } from 'shared/schemas'
import AdminOnlineUserController from '#app/controllers/http/admin/admin-online-user-controller.js'
import AdminOnlineHistoryController from '#app/controllers/http/admin/admin-online-history-controller.js'
import SupportController from '#app/controllers/http/support/support-controller.js'
import AdminKnowledgeBaseController from '#app/controllers/http/admin/admin-knowledge-base-controller.js'
import PushSubscriptionController from '#app/controllers/http/notifications/push-subscription-controller.js'
import AvatarController from '#app/controllers/http/user/avatar-controller.js'
import AccountController from '#app/controllers/http/user/account-controller.js'
import AccountSessionsController from '#app/controllers/http/user/account-sessions-controller.js'
import MfaController from '#app/controllers/http/auth/mfa-controller.js'
import PasskeyController from '#app/controllers/http/auth/passkey-controller.js'
import NotificationController from '#app/controllers/http/notifications/notification-controller.js'
import OAuthController from '#app/controllers/http/auth/oauth-controller.js'
import PromptController from '#app/controllers/http/ai/prompt-controller.js'
import LlmUsageController from '#app/controllers/http/ai/usage/llm-usage-controller.js'
import { defineRoute } from '#app/routes/contract-schemas/index.js'
import type { routeList } from '#vendor/types/types.js'
import {
    accountContracts,
    mfaContracts,
    passkeyContracts,
    adminContracts,
    authContracts,
    avatarContracts,
    knowledgeBaseContracts,
    mainContracts,
    notificationContracts,
    oauthContracts,
    promptContracts,
    pushSubscriptionContracts,
    supportContracts,
} from 'shared/contracts'

import {
    AVATAR_MAX_FILE_BYTES,
    KB_ARTICLE_MAX_BODY_BYTES,
    KB_SCREENSHOT_MAX_FILE_BYTES,
    PROMPT_MAX_BODY_BYTES,
    multipartBodyLimit,
} from '#app/services/shared/upload-limits.js'

export default [
    defineRoute({
        contract: mainContracts.ping,
        handler: MainController.ping.bind(MainController),
        description: 'Ping',
    }),
    defineRoute({
        contract: mainContracts.ready,
        handler: MainController.ready.bind(MainController),
        description: 'Readiness: 200 when PostgreSQL and Redis answer, 503 otherwise',
    }),
    {
        group: [
            defineRoute({
                contract: authContracts.registerEmail,
                handler: AuthController.registerByEmail.bind(AuthController),
                description: 'Register a new user by email',
            }),
            defineRoute({
                contract: authContracts.registerPhoneStart,
                handler: AuthController.startPhoneRegistration.bind(AuthController),
                description: 'Start phone-based registration',
            }),
            defineRoute({
                contract: authContracts.registerPhoneConfirm,
                handler: AuthController.confirmPhoneRegistration.bind(AuthController),
                description: 'Confirm phone registration challenge',
            }),
            defineRoute({
                contract: authContracts.registerPhoneComplete,
                handler: AuthController.completePhoneRegistration.bind(AuthController),
                description: 'Complete phone registration profile and password',
            }),
            defineRoute({
                contract: authContracts.login,
                handler: AuthController.login.bind(AuthController),
                description: 'Login a user by email or phone identifier',
            }),
            defineRoute({
                contract: authContracts.mfaVerify,
                handler: AuthController.mfaVerify.bind(AuthController),
                description:
                    'Second sign-in step (feat-245): TOTP or recovery code against the ticket cookie',
            }),
            defineRoute({
                contract: authContracts.mfaState,
                handler: AuthController.mfaState.bind(AuthController),
                description:
                    'Whether this browser holds a second sign-in step (feat-245), after a reload',
            }),
            defineRoute({
                contract: authContracts.mfaWebauthnOptions,
                handler: AuthController.mfaWebauthnOptions.bind(AuthController),
                description: 'Options of a passkey as the second sign-in step (feat-246)',
            }),
            defineRoute({
                contract: authContracts.logout,
                handler: AuthController.logout.bind(AuthController),
                description: 'Logout a user',
                middlewares: ['auth_guard'],
                allowInRecovery: true,
            }),
            defineRoute({
                contract: authContracts.reauthOptions,
                handler: AuthController.reauthOptions.bind(AuthController),
                description: 'Step-up proofs this account can give (feat-245)',
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: authContracts.reauth,
                handler: AuthController.reauth.bind(AuthController),
                description:
                    'Step-up of this session by a password, a TOTP code or a passkey (feat-245, feat-246)',
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: authContracts.reauthWebauthnOptions,
                handler: AuthController.reauthWebauthnOptions.bind(AuthController),
                description: 'Options of a passkey step-up of this session (feat-246)',
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: authContracts.recoveryFinish,
                handler: AuthController.recoveryFinish.bind(AuthController),
                description: 'End a recovery session (feat-245); sign in again afterwards',
                middlewares: ['auth_guard'],
                allowInRecovery: true,
            }),
            defineRoute({
                contract: authContracts.logoutAll,
                handler: AuthController.logoutAll.bind(AuthController),
                description: 'Logout all devices',
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: authContracts.changePassword,
                handler: AuthController.changePassword.bind(AuthController),
                description: 'Change or set user password',
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: authContracts.forgotPassword,
                handler: AuthController.forgotPassword.bind(AuthController),
                description: 'Request password reset email',
                rateLimit: { windowMs: 60_000, maxRequests: 3 },
            }),
            defineRoute({
                contract: authContracts.resetPhoneStart,
                handler: AuthController.startPhonePasswordReset.bind(AuthController),
                description: 'Start phone-based password reset flow',
            }),
            defineRoute({
                contract: authContracts.resetPhoneComplete,
                handler: AuthController.completePhonePasswordReset.bind(AuthController),
                description: 'Complete phone-based password reset flow',
            }),
            defineRoute({
                contract: authContracts.resetPassword,
                handler: AuthController.resetPassword.bind(AuthController),
                description: 'Reset password using a one-time token',
                rateLimit: { windowMs: 60_000, maxRequests: 10 },
            }),
            defineRoute({
                contract: authContracts.verifyEmail,
                handler: AuthController.verifyEmail.bind(AuthController),
                description: 'Confirm user email by verification token',
                rateLimit: { windowMs: 60_000, maxRequests: 10 },
            }),
            defineRoute({
                contract: authContracts.resendVerificationEmail,
                handler: AuthController.resendVerificationEmail.bind(AuthController),
                description: 'Resend verification email to authenticated user',
                middlewares: ['auth_guard'],
                rateLimit: { windowMs: 60_000, maxRequests: 3 },
            }),
            defineRoute({
                contract: authContracts.linkPhoneStart,
                handler: AuthController.startPhoneLink.bind(AuthController),
                description: 'Start linking a phone to the current account',
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: authContracts.linkPhoneConfirm,
                handler: AuthController.confirmPhoneLink.bind(AuthController),
                description: 'Confirm and link a phone to the current account',
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: authContracts.linkEmailStart,
                handler: AuthController.startEmailLink.bind(AuthController),
                description:
                    'Send an email verification link for adding an email to the current account',
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: authContracts.signInMethods,
                handler: SignInMethodsController.list.bind(SignInMethodsController),
                description: 'List the sign-in methods linked to the current account',
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: authContracts.unlinkSignInMethod,
                handler: SignInMethodsController.unlink.bind(SignInMethodsController),
                description: 'Remove a linked sign-in method from the current account',
                middlewares: ['auth_guard'],
            }),
        ],
        description: 'Auth routes',
        middlewares: ['session_web', 'csrf_guard'],
        prefix: 'auth',
        rateLimit: { windowMs: 60_000, maxRequests: 10 },
    },
    {
        group: [
            defineRoute({
                contract: authContracts.passkeyOptions,
                handler: AuthController.passkeyOptions.bind(AuthController),
                description: 'Options of a passwordless sign-in with a passkey (feat-246)',
            }),
            defineRoute({
                contract: authContracts.passkeyVerify,
                handler: AuthController.passkeyVerify.bind(AuthController),
                description: 'Sign in with a passkey alone (feat-246): a full, level-2 sign-in',
            }),
        ],
        // feat-246: the sign-in page asks for passkey options for its autofill; they must not
        // spend the budget of the password sign-in. verify keeps the login IP budget.
        description: 'Passkey sign-in routes (feat-246)',
        middlewares: ['session_web', 'csrf_guard'],
        prefix: 'auth/passkey',
        rateLimit: { windowMs: 60_000, maxRequests: 30 },
    },
    {
        group: [
            defineRoute({
                contract: oauthContracts.providers,
                handler: OAuthController.providers.bind(OAuthController),
                description: 'OAuth providers configured on the backend',
            }),
            defineRoute({
                contract: oauthContracts.redirect,
                handler: OAuthController.redirect.bind(OAuthController),
                description: 'Redirect to OAuth provider',
            }),
            defineRoute({
                contract: oauthContracts.callback,
                handler: OAuthController.callback.bind(OAuthController),
                queryAllowExtra: true,
                description: 'OAuth provider callback',
            }),
            defineRoute({
                contract: oauthContracts.confirmLink,
                handler: OAuthController.confirmLink.bind(OAuthController),
                description: 'Confirm a mailed OAuth link in the browser that started the sign-in',
            }),
            defineRoute({
                contract: oauthContracts.resendEmailLink,
                handler: OAuthController.resendEmailLink.bind(OAuthController),
                description: 'Send again the link confirming the address of an OAuth account',
                middlewares: ['auth_guard'],
            }),
        ],
        description: 'OAuth routes',
        middlewares: ['session_web', 'csrf_guard'],
        prefix: 'auth/oauth',
        rateLimit: { windowMs: 60_000, maxRequests: 20 },
    },
    {
        group: [
            defineRoute({
                contract: mainContracts.init,
                handler: MainController.init.bind(MainController),
                description: 'Initialize app state',
                middlewares: ['auth_guard'],
                allowInRecovery: true,
            }),
            defineRoute({
                contract: mainContracts.updateWsToken,
                handler: MainController.updateWsToken.bind(MainController),
                description: 'Update the WebSocket token',
                middlewares: ['auth_guard'],
            }),
        ],
        description: 'Main routes',
        middlewares: ['session_web', 'csrf_guard'],
        prefix: 'main',
    },
    {
        group: [
            defineRoute({
                contract: pushSubscriptionContracts.vapidPublicKey,
                handler: PushSubscriptionController.getVapidPublicKey.bind(
                    PushSubscriptionController,
                ),
                description: 'Get VAPID public key for push subscriptions',
            }),
            defineRoute({
                contract: pushSubscriptionContracts.testPush,
                handler: PushSubscriptionController.testPush.bind(PushSubscriptionController),
                description: 'Send a test push notification to the current user',
                middlewares: ['auth_guard'],
                // feat-104: every call fans out to all the user's devices.
                rateLimit: { windowMs: 60_000, maxRequests: 5 },
            }),
            defineRoute({
                contract: pushSubscriptionContracts.list,
                handler: PushSubscriptionController.getSubscriptions.bind(
                    PushSubscriptionController,
                ),
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: pushSubscriptionContracts.create,
                handler: PushSubscriptionController.createSubscription.bind(
                    PushSubscriptionController,
                ),
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: pushSubscriptionContracts.get,
                handler: PushSubscriptionController.getSubscription.bind(
                    PushSubscriptionController,
                ),
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: pushSubscriptionContracts.update,
                handler: PushSubscriptionController.updateSubscription.bind(
                    PushSubscriptionController,
                ),
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: pushSubscriptionContracts.remove,
                handler: PushSubscriptionController.deleteSubscription.bind(
                    PushSubscriptionController,
                ),
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: pushSubscriptionContracts.logs,
                handler: PushSubscriptionController.getSubscriptionLogs.bind(
                    PushSubscriptionController,
                ),
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: pushSubscriptionContracts.statistics,
                handler: PushSubscriptionController.getSubscriptionStatistics.bind(
                    PushSubscriptionController,
                ),
                middlewares: ['auth_guard'],
            }),
            defineRoute({
                contract: pushSubscriptionContracts.deactivate,
                handler: PushSubscriptionController.deactivateSubscription.bind(
                    PushSubscriptionController,
                ),
                middlewares: ['auth_guard'],
            }),
        ],
        description: 'Push Subscription routes',
        middlewares: ['session_web', 'csrf_guard'],
        prefix: 'push-subscriptions',
    },
    {
        group: [
            defineRoute({
                contract: avatarContracts.upload,
                handler: AvatarController.uploadAvatar.bind(AvatarController),
                maxBodySize: multipartBodyLimit(AVATAR_MAX_FILE_BYTES),
                // feat-202: no upload is buffered for a request without a signed-in cookie.
                signedInBeforeBody: true,
                description: 'Upload user avatar',
            }),
            defineRoute({
                contract: avatarContracts.remove,
                handler: AvatarController.deleteAvatar.bind(AvatarController),
                description: 'Delete user avatar',
            }),
        ],
        description: 'Avatar routes',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard'],
        prefix: 'avatar',
        rateLimit: { windowMs: 60_000, maxRequests: 10 },
    },
    {
        group: [
            defineRoute({
                contract: accountContracts.getProfile,
                handler: AccountController.getProfile.bind(AccountController),
                description: 'Profile of the current user: name, preferences and revision',
            }),
            defineRoute({
                contract: accountContracts.getAccess,
                handler: AccountController.getAccess.bind(AccountController),
                description: 'Role of the current user (feat-240), read again by a tab',
            }),
            defineRoute({
                contract: accountContracts.updateProfile,
                handler: AccountController.updateProfile.bind(AccountController),
                description:
                    'Change the name and preferences of the current user (absent field unchanged, null resets)',
            }),
            defineRoute({
                contract: accountContracts.listSessions,
                handler: AccountSessionsController.listSessions.bind(AccountSessionsController),
                description:
                    'Active sessions of the current user: the current one, then pages of the others',
            }),
            defineRoute({
                contract: accountContracts.revokeSession,
                handler: AccountSessionsController.revokeSession.bind(AccountSessionsController),
                description: 'End one other session of the current user',
            }),
            defineRoute({
                contract: accountContracts.revokeOtherSessions,
                handler:
                    AccountSessionsController.revokeOtherSessions.bind(AccountSessionsController),
                description: 'End every session of the current user but this one, which is renewed',
            }),
        ],
        description: 'Account profile and session routes (feat-232, feat-233)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard'],
        prefix: 'account',
    },
    {
        group: [
            defineRoute({
                contract: mfaContracts.status,
                handler: MfaController.status.bind(MfaController),
                allowInRecovery: true,
                description: 'Second factors and recovery codes of the current user (feat-245)',
            }),
            defineRoute({
                contract: mfaContracts.totpSetup,
                handler: MfaController.totpSetup.bind(MfaController),
                allowInRecovery: true,
                description:
                    'Start a TOTP setup (needs a fresh proof); the secret stays in this session',
            }),
            defineRoute({
                contract: mfaContracts.totpConfirm,
                handler: MfaController.totpConfirm.bind(MfaController),
                allowInRecovery: true,
                description:
                    'Confirm the TOTP setup with a code; replaces the previous app; idempotent',
            }),
            defineRoute({
                contract: mfaContracts.totpDisable,
                handler: MfaController.totpDisable.bind(MfaController),
                allowInRecovery: true,
                description: 'Turn the TOTP factor off (needs a fresh second factor)',
            }),
            defineRoute({
                contract: mfaContracts.regenerateRecoveryCodes,
                handler: MfaController.regenerateRecoveryCodes.bind(MfaController),
                allowInRecovery: true,
                description: 'Issue new recovery codes; the previous ones stop working',
            }),
        ],
        description: 'Second factors of the account (feat-245)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard'],
        prefix: 'account/mfa',
        rateLimit: { windowMs: 60_000, maxRequests: 20 },
    },
    {
        group: [
            defineRoute({
                contract: passkeyContracts.list,
                handler: PasskeyController.list.bind(PasskeyController),
                allowInRecovery: true,
                description: 'Passkeys of the current user (feat-246)',
            }),
            defineRoute({
                contract: passkeyContracts.registerOptions,
                handler: PasskeyController.registerOptions.bind(PasskeyController),
                allowInRecovery: true,
                description:
                    'Options of a new passkey (needs a fresh proof); the challenge stays in this session',
            }),
            defineRoute({
                contract: passkeyContracts.register,
                handler: PasskeyController.register.bind(PasskeyController),
                allowInRecovery: true,
                description: 'Store the new passkey; idempotent by the enrollment id',
            }),
            defineRoute({
                contract: passkeyContracts.rename,
                handler: PasskeyController.rename.bind(PasskeyController),
                description: 'Rename a passkey of the current user',
            }),
            defineRoute({
                contract: passkeyContracts.remove,
                handler: PasskeyController.remove.bind(PasskeyController),
                allowInRecovery: true,
                description:
                    'Remove a passkey (needs a fresh second factor; keeps the last way in)',
            }),
        ],
        description: 'Passkeys of the account (feat-246)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard'],
        prefix: 'account/passkeys',
        rateLimit: { windowMs: 60_000, maxRequests: 20 },
    },
    {
        group: [
            defineRoute({
                contract: notificationContracts.list,
                handler: NotificationController.list.bind(NotificationController),
                description: 'A page of the notifications of the current user, newest first',
            }),
            defineRoute({
                contract: notificationContracts.unreadCount,
                handler: NotificationController.unreadCount.bind(NotificationController),
                description: 'The unread notification count of the current user, up to 100',
            }),
            defineRoute({
                contract: notificationContracts.readAll,
                handler: NotificationController.readAll.bind(NotificationController),
                description: 'Mark every notification up to an id read',
            }),
            defineRoute({
                contract: notificationContracts.getPreferences,
                handler: NotificationController.getPreferences.bind(NotificationController),
                description: 'The notification channels of each category',
            }),
            defineRoute({
                contract: notificationContracts.updatePreference,
                handler: NotificationController.updatePreference.bind(NotificationController),
                description: 'Turn one channel of a category on or off',
            }),
            defineRoute({
                contract: notificationContracts.markRead,
                handler: NotificationController.markRead.bind(NotificationController),
                description: 'Mark one notification read; answers its link (idempotent)',
            }),
        ],
        description: 'Notification center (feat-236)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard'],
        prefix: 'notifications',
    },
    {
        group: [
            defineRoute({
                contract: supportContracts.history,
                handler: SupportController.getChatHistory.bind(SupportController),
                description:
                    'Get a page of the support chat history (latest first page; `before` for older)',
            }),
            defineRoute({
                contract: supportContracts.deleteHistory,
                handler: SupportController.deleteChatHistory.bind(SupportController),
                description: 'Delete all support chat history',
            }),
            defineRoute({
                contract: supportContracts.screenshot,
                handler: SupportController.getScreenshot.bind(SupportController),
                description: 'Get screenshot for a knowledge base article',
            }),
        ],
        description: 'Support routes',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard'],
        prefix: 'support',
    },
    {
        group: [
            defineRoute({
                contract: knowledgeBaseContracts.list,
                handler: AdminKnowledgeBaseController.getAll.bind(AdminKnowledgeBaseController),
                description: 'List all knowledge base articles',
            }),
            defineRoute({
                contract: knowledgeBaseContracts.get,
                handler: AdminKnowledgeBaseController.getById.bind(AdminKnowledgeBaseController),
                description: 'Get a knowledge base article by id',
            }),
            defineRoute({
                contract: knowledgeBaseContracts.initStatus,
                handler: AdminKnowledgeBaseController.getInitStatus.bind(
                    AdminKnowledgeBaseController,
                ),
                description: 'Get knowledge base initialization status',
            }),
        ],
        description: 'Admin Knowledge Base: read (feat-240)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:kb.read'],
        prefix: 'admin',
    },
    {
        group: [
            defineRoute({
                contract: knowledgeBaseContracts.create,
                handler: AdminKnowledgeBaseController.create.bind(AdminKnowledgeBaseController),
                maxBodySize: KB_ARTICLE_MAX_BODY_BYTES,
                description: 'Create a knowledge base article',
            }),
            defineRoute({
                contract: knowledgeBaseContracts.update,
                handler: AdminKnowledgeBaseController.update.bind(AdminKnowledgeBaseController),
                maxBodySize: KB_ARTICLE_MAX_BODY_BYTES,
                description: 'Update a knowledge base article',
            }),
            defineRoute({
                contract: knowledgeBaseContracts.remove,
                handler: AdminKnowledgeBaseController.delete.bind(AdminKnowledgeBaseController),
                description: 'Delete a knowledge base article',
            }),
            defineRoute({
                contract: knowledgeBaseContracts.uploadScreenshot,
                handler: AdminKnowledgeBaseController.uploadScreenshot.bind(
                    AdminKnowledgeBaseController,
                ),
                maxBodySize: multipartBodyLimit(KB_SCREENSHOT_MAX_FILE_BYTES),
                // feat-202: this group had no rate limit, and the body is read before the
                // session and permission checks.
                signedInBeforeBody: true,
                rateLimit: { windowMs: 60_000, maxRequests: 10 },
                description: 'Upload screenshot for a knowledge base article',
            }),
            defineRoute({
                contract: knowledgeBaseContracts.removeScreenshot,
                handler: AdminKnowledgeBaseController.deleteScreenshot.bind(
                    AdminKnowledgeBaseController,
                ),
                description: 'Delete screenshot for a knowledge base article',
            }),
            defineRoute({
                contract: knowledgeBaseContracts.reindex,
                handler: AdminKnowledgeBaseController.reindex.bind(AdminKnowledgeBaseController),
                description: 'Reindex a knowledge base article',
            }),
        ],
        description: 'Admin Knowledge Base: edit articles (feat-240)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:kb.write'],
        prefix: 'admin',
    },
    {
        group: [
            defineRoute({
                contract: knowledgeBaseContracts.reindexAll,
                handler: AdminKnowledgeBaseController.reindexAll.bind(AdminKnowledgeBaseController),
                description: 'Reindex all knowledge base articles',
            }),
            defineRoute({
                contract: knowledgeBaseContracts.startInit,
                handler: AdminKnowledgeBaseController.startInit.bind(AdminKnowledgeBaseController),
                description: 'Initialize knowledge base from docs/support-knowledge-base',
            }),
        ],
        description: 'Admin Knowledge Base: bulk provider calls (feat-240)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:kb.manage'],
        prefix: 'admin',
    },
    {
        group: [
            defineRoute({
                contract: promptContracts.list,
                handler: PromptController.list.bind(PromptController),
                description: 'List retained Support AI prompts',
            }),
            defineRoute({
                contract: promptContracts.get,
                handler: PromptController.getByType.bind(PromptController),
                description: 'Get a retained Support AI prompt by type',
            }),
            defineRoute({
                contract: promptContracts.update,
                handler: PromptController.update.bind(PromptController),
                maxBodySize: PROMPT_MAX_BODY_BYTES,
                description: 'Update a retained Support AI prompt by type',
            }),
            defineRoute({
                contract: promptContracts.test,
                handler: PromptController.testPrompt.bind(PromptController),
                description: 'Test a retained Support AI prompt with a user message',
            }),
        ],
        description: 'Support AI prompt management routes',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:prompts.manage'],
        prefix: 'prompts',
    },
    {
        group: [
            defineRoute({
                contract: adminContracts.textUsage,
                handler: LlmUsageController.getTextUsage.bind(LlmUsageController),
                description: 'Get retained Support AI text token usage (admin)',
            }),
            defineRoute({
                contract: adminContracts.usageStats,
                handler: LlmUsageController.getStats.bind(LlmUsageController),
                description: 'Get retained Support AI usage aggregate stats (admin)',
            }),
        ],
        description: 'Admin retained LLM usage',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:ai_usage.read'],
        prefix: 'admin',
    },
    {
        group: [
            defineRoute({
                contract: adminContracts.onlineUsers,
                handler: AdminOnlineUserController.list.bind(AdminOnlineUserController),
                description: 'List online users (admin)',
            }),
            defineRoute({
                contract: adminContracts.users,
                handler: AdminUserController.list.bind(AdminUserController),
                description: 'List users with filters (admin)',
            }),
        ],
        description: 'Admin users and online users (feat-240)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:users.read'],
        prefix: 'admin',
    },
    {
        group: [
            defineRoute({
                contract: adminContracts.setUserRole,
                handler: AdminUserController.setRole.bind(AdminUserController),
                description: 'Change the role of a user (feat-241)',
            }),
        ],
        description: 'Admin role assignment (feat-241)',
        rateLimit: { windowMs: 60_000, maxRequests: 30 },
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:users.roles.assign'],
        prefix: 'admin',
    },
    {
        group: [
            defineRoute({
                contract: adminContracts.resetUserMfa,
                handler: AdminUserController.resetMfa.bind(AdminUserController),
                description:
                    'Reset the second factors of another account (feat-247): needs a fresh proof; keeps the last way in',
            }),
        ],
        description: 'Admin MFA reset (feat-247)',
        rateLimit: { windowMs: 60_000, maxRequests: 10 },
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:users.mfa.reset'],
        prefix: 'admin',
    },
    {
        group: [
            defineRoute({
                contract: adminContracts.onlineHistory,
                handler: AdminOnlineHistoryController.list.bind(AdminOnlineHistoryController),
                description: 'List online history records (admin)',
            }),
            defineRoute({
                contract: adminContracts.onlineUser,
                handler: AdminOnlineUserController.getById.bind(AdminOnlineUserController),
                description: 'Get online user detail (admin)',
            }),
        ],
        description: 'Admin online user detail and history: phone, IP, user agent (feat-240)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:users.sensitive.read'],
        prefix: 'admin',
    },
    {
        group: [
            defineRoute({
                contract: adminContracts.auditEvents,
                handler: AdminAuditEventsController.list.bind(AdminAuditEventsController),
                queryArrays: AUDIT_EVENTS_QUERY_ARRAYS,
                description: 'List the audit log, newest first, by filters',
            }),
        ],
        description:
            'Admin audit log (feat-235); without audit.read only sign-in and sessions (feat-240)',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'can:audit.read.account'],
        prefix: 'admin',
    },
] satisfies routeList
