import MainController from '#app/controllers/http/core/main-controller.js'
import AuthController from '#app/controllers/http/auth/auth-controller.js'
import AdminUserController from '#app/controllers/http/admin/admin-user-controller.js'
import AdminOnlineUserController from '#app/controllers/http/admin/admin-online-user-controller.js'
import AdminOnlineHistoryController from '#app/controllers/http/admin/admin-online-history-controller.js'
import SupportController from '#app/controllers/http/support/support-controller.js'
import AdminKnowledgeBaseController from '#app/controllers/http/admin/admin-knowledge-base-controller.js'
import PushSubscriptionController from '#app/controllers/http/notifications/push-subscription-controller.js'
import AvatarController from '#app/controllers/http/user/avatar-controller.js'
import OAuthController from '#app/controllers/http/auth/oauth-controller.js'
import PromptController from '#app/controllers/http/ai/prompt-controller.js'
import LlmUsageController from '#app/controllers/http/ai/usage/llm-usage-controller.js'
import { defineRoute } from '#app/routes/contract-schemas/index.js'
import type { routeList } from '#vendor/types/types.js'
import {
    adminContracts,
    authContracts,
    avatarContracts,
    knowledgeBaseContracts,
    mainContracts,
    oauthContracts,
    promptContracts,
    pushSubscriptionContracts,
    supportContracts,
} from 'shared/contracts'

import {
    AVATAR_MAX_FILE_BYTES,
    KB_SCREENSHOT_MAX_FILE_BYTES,
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
                contract: authContracts.logout,
                handler: AuthController.logout.bind(AuthController),
                description: 'Logout a user',
                middlewares: ['auth_guard'],
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
        ],
        description: 'Auth routes',
        middlewares: ['session_web', 'csrf_guard'],
        prefix: 'auth',
        rateLimit: { windowMs: 60_000, maxRequests: 10 },
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
                contract: knowledgeBaseContracts.create,
                handler: AdminKnowledgeBaseController.create.bind(AdminKnowledgeBaseController),
                description: 'Create a knowledge base article',
            }),
            defineRoute({
                contract: knowledgeBaseContracts.update,
                handler: AdminKnowledgeBaseController.update.bind(AdminKnowledgeBaseController),
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
            defineRoute({
                contract: knowledgeBaseContracts.initStatus,
                handler: AdminKnowledgeBaseController.getInitStatus.bind(
                    AdminKnowledgeBaseController,
                ),
                description: 'Get knowledge base initialization status',
            }),
        ],
        description: 'Admin Knowledge Base routes',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'admin_guard'],
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
                description: 'Update a retained Support AI prompt by type',
            }),
            defineRoute({
                contract: promptContracts.test,
                handler: PromptController.testPrompt.bind(PromptController),
                description: 'Test a retained Support AI prompt with a user message',
            }),
        ],
        description: 'Support AI prompt management routes',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'admin_guard'],
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
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'admin_guard'],
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
                contract: adminContracts.onlineHistory,
                handler: AdminOnlineHistoryController.list.bind(AdminOnlineHistoryController),
                description: 'List online history records (admin)',
            }),
            defineRoute({
                contract: adminContracts.onlineUser,
                handler: AdminOnlineUserController.getById.bind(AdminOnlineUserController),
                description: 'Get online user detail (admin)',
            }),
            defineRoute({
                contract: adminContracts.users,
                handler: AdminUserController.list.bind(AdminUserController),
                description: 'List users with filters (admin)',
            }),
        ],
        description: 'Admin user and online routes',
        middlewares: ['session_web', 'csrf_guard', 'auth_guard', 'admin_guard'],
        prefix: 'admin',
    },
] satisfies routeList
