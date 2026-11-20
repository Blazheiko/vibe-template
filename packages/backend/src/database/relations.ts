import { defineRelations } from 'drizzle-orm'
import * as schema from './schema.js'

// Relational Queries v2 (drizzle-orm 1.0). Same relations as the former
// per-table `relations()` declarations in schema.ts.
export const relations = defineRelations(schema, (r) => ({
    users: {
        oauthAccounts: r.many.oauthAccounts({ from: r.users.id, to: r.oauthAccounts.userId }),
        emailVerifications: r.many.emailVerifications({
            from: r.users.id,
            to: r.emailVerifications.userId,
        }),
        emailLinkVerifications: r.many.emailLinkVerifications({
            from: r.users.id,
            to: r.emailLinkVerifications.userId,
        }),
        passwordResetTokens: r.many.passwordResetTokens({
            from: r.users.id,
            to: r.passwordResetTokens.userId,
        }),
        onlineSessions: r.many.userOnline({ from: r.users.id, to: r.userOnline.userId }),
        pushSubscriptions: r.many.pushSubscriptions({
            from: r.users.id,
            to: r.pushSubscriptions.userId,
        }),
        pushNotificationLogs: r.many.pushNotificationLogs({
            from: r.users.id,
            to: r.pushNotificationLogs.userId,
        }),
        llmTextUsage: r.many.llmTextUsage({ from: r.users.id, to: r.llmTextUsage.userId }),
        supportChatHistory: r.many.supportChatHistory({
            from: r.users.id,
            to: r.supportChatHistory.userId,
        }),
        notifications: r.many.notifications({ from: r.users.id, to: r.notifications.userId }),
        notificationPreferences: r.many.notificationPreferences({
            from: r.users.id,
            to: r.notificationPreferences.userId,
        }),
        preferences: r.one.userPreferences({
            from: r.users.id,
            to: r.userPreferences.userId,
        }),
    },
    userPreferences: {
        user: r.one.users({ from: r.userPreferences.userId, to: r.users.id }),
    },
    userOnline: {
        user: r.one.users({ from: r.userOnline.userId, to: r.users.id }),
    },
    notifications: {
        user: r.one.users({ from: r.notifications.userId, to: r.users.id }),
    },
    notificationPreferences: {
        user: r.one.users({ from: r.notificationPreferences.userId, to: r.users.id }),
    },
    pushSubscriptions: {
        user: r.one.users({ from: r.pushSubscriptions.userId, to: r.users.id }),
        notificationLogs: r.many.pushNotificationLogs({
            from: r.pushSubscriptions.id,
            to: r.pushNotificationLogs.subscriptionId,
        }),
    },
    pushNotificationLogs: {
        user: r.one.users({ from: r.pushNotificationLogs.userId, to: r.users.id }),
        subscription: r.one.pushSubscriptions({
            from: r.pushNotificationLogs.subscriptionId,
            to: r.pushSubscriptions.id,
        }),
    },
    emailVerifications: {
        user: r.one.users({ from: r.emailVerifications.userId, to: r.users.id }),
    },
    emailLinkVerifications: {
        user: r.one.users({ from: r.emailLinkVerifications.userId, to: r.users.id }),
    },
    passwordResetTokens: {
        user: r.one.users({ from: r.passwordResetTokens.userId, to: r.users.id }),
    },
    oauthAccounts: {
        user: r.one.users({ from: r.oauthAccounts.userId, to: r.users.id }),
    },
    llmSystemPrompts: {
        textUsage: r.many.llmTextUsage({
            from: r.llmSystemPrompts.id,
            to: r.llmTextUsage.llmSystemPromptId,
        }),
    },
    llmTextUsage: {
        user: r.one.users({ from: r.llmTextUsage.userId, to: r.users.id }),
        prompt: r.one.llmSystemPrompts({
            from: r.llmTextUsage.llmSystemPromptId,
            to: r.llmSystemPrompts.id,
        }),
    },
    supportChatHistory: {
        user: r.one.users({ from: r.supportChatHistory.userId, to: r.users.id }),
    },
}))
