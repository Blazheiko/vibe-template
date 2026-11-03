import logger from '#vendor/utils/logger.js'
import {
    pushNotificationSenderService,
    type PushNotificationPayload,
} from '#app/services/notifications/push-notification-sender-service.js'

// Business events that send a push (code-issues item 72). Fire-and-forget: a push
// failure or slow push service never changes or delays the response that triggered it.

export type SecurityEvent =
    'new_sign_in' | 'password_changed' | 'password_reset' | 'logout_all' | 'account_claimed'

const SECURITY_MESSAGES: Record<SecurityEvent, PushNotificationPayload> = {
    new_sign_in: {
        title: 'New sign-in',
        body: 'Your account was just signed in to. If it was not you, change your password.',
        url: '/account',
        tag: 'security-sign-in',
    },
    password_changed: {
        title: 'Password changed',
        body: 'Your password was changed. If it was not you, reset it now.',
        url: '/account',
        tag: 'security-password',
    },
    password_reset: {
        title: 'Password reset',
        body: 'Your password was reset and other sessions were signed out.',
        url: '/account',
        tag: 'security-password',
    },
    logout_all: {
        title: 'Signed out everywhere',
        body: 'All sessions of your account were signed out.',
        url: '/account',
        tag: 'security-sessions',
    },
    account_claimed: {
        title: 'Account secured',
        body: 'Your email was confirmed. Earlier sign-in methods and sessions were removed.',
        url: '/account',
        tag: 'security-sessions',
    },
}

const send = (
    userId: bigint,
    payload: PushNotificationPayload,
    options: { skipIfOnline?: boolean; notificationType: 'system' | 'mention' },
    event: string,
): void => {
    pushNotificationSenderService.sendToUser(userId, payload, options).catch((err: unknown) => {
        logger.warn({ err, userId: String(userId), event }, 'Push for a business event failed')
    })
}

export const userNotificationService = {
    /** Security notices go to every device, online or not. */
    security(userId: bigint, event: SecurityEvent): void {
        send(userId, SECURITY_MESSAGES[event], { notificationType: 'system' }, event)
    },

    /** A support reply reaches the user only when no device has the app open. */
    supportReply(userId: bigint): void {
        send(
            userId,
            {
                title: 'Support replied',
                body: 'A new answer is waiting in the support chat.',
                url: '/support',
                tag: 'support-reply',
            },
            { skipIfOnline: true, notificationType: 'mention' },
            'support_reply',
        )
    },
}
