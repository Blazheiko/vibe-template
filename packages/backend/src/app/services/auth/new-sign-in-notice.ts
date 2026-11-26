import { Result } from 'better-result'
import type { SessionToken } from '#app/domain/secrets.js'
import { PRODUCT } from 'shared/product'
import { UTC_TIME_ZONE, describeDevice, isAllowedTimeZone, parseUserAgent } from 'shared/utils'

import appConfig from '#config/app.js'
import { throttlePolicies } from '#config/throttle-policies.js'
import { userPreferencesRepository, userRepository } from '#app/repositories/index.js'
import { consumeAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import { providerTitle } from '#app/services/auth/oauth-provider-titles.js'
import { emailService } from '#app/services/notifications/email-service.js'
import {
    mailAddresseeName,
    renderBrandedEmail,
} from '#app/services/notifications/email-templates.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'
import type { SessionDevice } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import { listSessions } from '#vendor/utils/session/redis-session-storage.js'
import type { IndexPosition } from '#vendor/utils/session/session-page-cursor.js'
import type { UserId } from '#app/domain/ids.js'

// feat-233 (Р11): a new sign-in is announced by a push that names the device and, under the
// rules below, by a mail with the details and a link to the session list. The caller of
// auth.login decides whether to announce it (a registration, a renewal and a link are not).
//
// The mail goes only (1) to a confirmed address: an unconfirmed one may be somebody else's;
// (2) when the device is not "familiar": another live session of the user (any page of the
// list) has the same browser,
// operating system and IP. That is a heuristic to send fewer mails, not proof of identity: a
// device of the same kind behind the same NAT passes too, and an unknown browser or system is
// never familiar; (3) within newSignInMailUser (5 an hour per user by default). The push always
// goes.

export const SESSIONS_PAGE_PATH = '/account#sessions'

/** "Chrome on macOS", or a neutral word when the User-Agent tells nothing. */
export const deviceLabel = (userAgent: string): string =>
    describeDevice(parseUserAgent(userAgent)) ?? 'an unknown device'

const methodLabel = (device: SessionDevice): string => {
    switch (device.method) {
        case 'oauth':
            return device.provider !== undefined ? providerTitle(device.provider) : 'a provider'
        case 'register':
            return 'registration'
        case 'password':
            return 'password'
        case 'passkey':
            return 'passkey'
    }
}

/** The sign-in time as the user reads it: their time zone, or UTC. */
export const formatSignInTime = (iso: string, timeZone: string | null): string => {
    const zone = timeZone !== null && isAllowedTimeZone(timeZone) ? timeZone : UTC_TIME_ZONE
    const date = new Date(iso)
    const text = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(Number.isNaN(date.getTime()) ? new Date() : date)
    return `${text} (${zone})`
}

export interface NewSignInMail {
    name: string
    device: SessionDevice
    timeZone: string | null
}

export function renderNewSignInEmail(notice: NewSignInMail): ReturnType<typeof renderBrandedEmail> {
    const { device } = notice
    const parsed = parseUserAgent(device.userAgent)
    const url = `${appConfig.frontendUrl}${SESSIONS_PAGE_PATH}`
    const when = formatSignInTime(device.signedInAt, notice.timeZone)
    const browser = parsed.browser === 'unknown' ? 'unknown browser' : parsed.browser
    const os = parsed.os === 'unknown' ? 'unknown system' : parsed.os
    const ip = device.ip === '' ? 'unknown' : device.ip
    const intro = `Your ${PRODUCT.name} account was just signed in to: ${when}, ${browser} on ${os}, IP address ${ip}, with ${methodLabel(device)}.`
    const warning =
        'Not you? End that session on the account page and change your password right away.'
    return renderBrandedEmail({
        subject: `New sign-in to your ${PRODUCT.name} account`,
        eyebrow: 'Security notice',
        title: `New sign-in from ${deviceLabel(device.userAgent)}`,
        name: notice.name,
        intro,
        action: { kind: 'button', label: 'Review sessions', url },
        footer: warning,
        textLines: [
            `Your ${PRODUCT.name} account was just signed in to.`,
            '',
            `Time: ${when}`,
            `Browser: ${browser}`,
            `Operating system: ${os}`,
            `IP address: ${ip}`,
            `Signed in with: ${methodLabel(device)}`,
            '',
            warning,
            url,
        ],
    })
}

/**
 * Whether another live session of the user has the same browser, system and IP (rule 2). Follows
 * the pages of the list until a match or its end (feat-234: the first page alone missed a familiar
 * device further down). An unknown browser or system is never familiar.
 */
export const isFamiliarDevice = async (
    userToken: SessionToken,
    device: SessionDevice,
): Promise<boolean> => {
    const parsed = parseUserAgent(device.userAgent)
    if (parsed.browser === 'unknown' || parsed.os === 'unknown' || device.ip === '') return false
    let after: IndexPosition | null = null
    for (;;) {
        const page = await listSessions(userToken, { after, excludePublicId: device.publicId })
        const match = page.sessions.some((other) => {
            const otherDevice = other.info.data.device
            if (otherDevice?.ip !== device.ip) return false
            const seen = parseUserAgent(otherDevice.userAgent)
            return seen.browser === parsed.browser && seen.os === parsed.os
        })
        if (match) return true
        if (page.next === null) return false
        after = page.next
    }
}

/** The mail part: whether it went out, and if not, why (for tests and logs). */
export type NewSignInMailOutcome =
    'sent' | 'no_address' | 'unverified' | 'familiar' | 'throttled' | 'failed'

export const mailNewSignIn = async (
    userId: UserId,
    device: SessionDevice,
): Promise<NewSignInMailOutcome> => {
    const user = await userRepository.findById(userId)
    if (user?.email === undefined || user.email === null || user.email === '') return 'no_address'
    if (user.emailVerifiedAt === null) return 'unverified'
    if (await isFamiliarDevice(user.sessionToken, device)) return 'familiar'
    const budget = await consumeAuthThrottle(throttlePolicies.newSignInMailUser, String(userId))
    if (!budget.allowed) return 'throttled'

    const preferences = await userPreferencesRepository.findByUserId(userId)
    const content = renderNewSignInEmail({
        name: mailAddresseeName(user),
        device,
        timeZone: preferences?.timeZone ?? null,
    })
    const sent = await emailService.send({
        to: user.email,
        subject: content.subject,
        text: content.text,
        html: content.html,
    })
    if (Result.isError(sent)) {
        logger.warn(
            { error: sent.error._tag, userId: String(userId) },
            'New sign-in: the notice was not mailed',
        )
        return 'failed'
    }
    return 'sent'
}

/**
 * Announces a new sign-in (Р11): the push with the device, and with `mail` the mail under the
 * rules above. Fire-and-forget like every security notice: the sign-in is done, and a mail or
 * push service that fails or is slow must not change or delay its answer.
 */
export function notifyNewSignIn(
    userId: UserId,
    device: SessionDevice,
    options: { mail: boolean },
): void {
    userNotificationService.security(userId, 'new_sign_in', {
        device: deviceLabel(device.userAgent),
    })
    if (!options.mail) return
    mailNewSignIn(userId, device)
        .then((outcome) => {
            if (outcome !== 'sent') {
                logger.info({ userId: String(userId), outcome }, 'New sign-in: no mail')
            }
        })
        .catch((err: unknown) => {
            logger.warn({ err, userId: String(userId) }, 'New sign-in: the notice was not mailed')
        })
}
