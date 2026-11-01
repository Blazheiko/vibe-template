import { hashPassword, validatePassword } from 'metautil'
import { Result } from 'better-result'
import { nanoid } from 'nanoid'
import type { Auth, Session } from '#vendor/types/types.js'
import { smsAuthChallengeRepository, userRepository } from '#app/repositories/index.js'
import type { UserRow } from '#app/repositories/index.js'
import { userTransformer } from '#app/transformers/index.js'
import {
    badRequest,
    conflict,
    internalMessage,
    notFound,
    unauthorized,
    type AppResult,
} from '#app/services/shared/errors.js'
import { tryInternal } from '#app/services/shared/result-helpers.js'
import { generateWsToken } from '#app/services/auth/generate-ws-token-service.js'
import { getWsUrl } from '#app/services/communication/get-ws-url-service.js'
import { emailVerificationService } from '#app/services/auth/email-verification-service.js'
import logger from '#vendor/utils/logger.js'
import { maskPhoneForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { authConfig } from '#config/auth.js'
import {
    smsVerificationProvider,
    type SmsVerificationFlow,
} from '#app/services/auth/sms-verification-provider.js'
import { consumeAuthThrottle, resetAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { throttlePolicies } from '#config/throttle-policies.js'
import {
    hashOtpVerificationCode,
    verifyOtpVerificationCode,
} from '#app/services/auth/otp-verification-hash.js'
import {
    buildResendCooldownError,
    extractChallengeSessionId,
    extractChallengeUserId,
} from '#app/services/auth/sms-auth-challenge-metadata.js'
import { PENDING_SMS_CODE_HASH_PLACEHOLDER } from './sms-auth-challenge-constants.js'
import { looksLikePhoneNumber, normalizePhoneNumber } from 'shared/utils'
import type {
    ChangePasswordInput,
    LoginInput,
    RegisterEmailInput,
    RegisterPhoneStartInput,
    RegisterPhoneConfirmInput,
    RegisterPhoneCompleteInput,
    LinkPhoneStartInput,
    LinkPhoneConfirmInput,
    LinkEmailStartInput,
} from 'shared/schemas'
import type { Logger } from 'pino'
import { getSessionCsrfToken } from '#vendor/utils/session/csrf-token.js'
import { destroyAllSessions } from '#vendor/utils/session/redis-session-storage.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'

const REGISTER_PHONE_FLOW: SmsVerificationFlow = 'register_phone'
const LINK_PHONE_FLOW: SmsVerificationFlow = 'link_phone'

interface AuthSuccessPayload {
    status: 'success'
    user: ReturnType<typeof userTransformer.serialize>
    wsUrl: string
    wsToken: string
    csrfToken?: string
}

interface GenericAcceptedPayload {
    status: 'success'
    message: string
}

type RegisterEmailFlowPayload = AuthSuccessPayload | GenericAcceptedPayload

const GENERIC_EMAIL_REGISTRATION_MESSAGE =
    'If the email can be used for registration, continue with the verification instructions sent to your inbox.'

function isChallengeExpired(expiresAt: Date): boolean {
    return expiresAt.getTime() <= Date.now()
}

function assertPhoneAuthEnabled(): AppResult<never> | undefined {
    if (authConfig.phoneAuthEnabled) {
        return undefined
    }

    return Result.err(badRequest('Phone authentication is disabled'))
}

function resolveLoginIdentifier(payload: LoginInput): string {
    return 'identifier' in payload ? payload.identifier : payload.email
}

type LoginKey = { kind: 'email'; value: string } | { kind: 'phone'; value: string }

/**
 * The normalized login identifier, shared by the user lookup and the login
 * throttle so both see the same key. null when it cannot identify an account
 * (not an email or phone, phone auth disabled, unparsable phone).
 */
export function resolveLoginKey(identifier: string): LoginKey | null {
    const trimmed = identifier.trim()
    if (trimmed.includes('@')) {
        return { kind: 'email', value: normalizeEmail(trimmed) }
    }
    if (!looksLikePhoneNumber(trimmed) || !authConfig.phoneAuthEnabled) {
        return null
    }
    const phone = normalizePhone(trimmed)
    return Result.isError(phone) ? null : { kind: 'phone', value: phone.value }
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase()
}

function normalizePhone(input: string, defaultCountry?: string): AppResult<string> {
    try {
        return Result.ok(normalizePhoneNumber(input, defaultCountry))
    } catch (error) {
        if (error instanceof Error) {
            return Result.err(badRequest(error.message))
        }

        return Result.err(badRequest('Phone number must be valid and in a supported format'))
    }
}

async function createPasswordHash(password: string): Promise<AppResult<string>> {
    return await tryInternal(() => hashPassword(password), 'Failed to hash password')
}

async function requireCurrentPasswordReauth(
    userId: bigint,
    currentPassword: string,
): Promise<AppResult<UserRow>> {
    const userResult = await tryInternal(
        () => userRepository.findById(userId),
        'Failed to load user',
    )
    if (Result.isError(userResult)) {
        return Result.err(userResult.error)
    }

    const user = userResult.value
    if (user === undefined) {
        return Result.err(notFound('User', 'User not found'))
    }

    const passwordHash = user.password
    if (passwordHash === null || passwordHash === '') {
        return Result.err(badRequest('Set a password before managing recovery methods'))
    }

    const validResult = await tryInternal(
        () => validatePassword(currentPassword, passwordHash),
        'Failed to validate current password',
    )
    if (Result.isError(validResult)) {
        return Result.err(validResult.error)
    }

    if (!validResult.value) {
        return Result.err(badRequest('Current password is incorrect'))
    }

    return Result.ok(user)
}

async function buildAuthSuccess(
    user: Awaited<ReturnType<typeof userRepository.create>>,
    auth: Auth,
    session: Session,
    loginFailureMessage = 'Failed to log in user',
): Promise<AppResult<AuthSuccessPayload>> {
    const loggedInResult = await tryInternal(
        () => auth.login(String(user.id), user.sessionToken),
        'Failed to log in user',
    )
    if (Result.isError(loggedInResult)) {
        return Result.err(loggedInResult.error)
    }

    if (!loggedInResult.value) {
        return Result.err(internalMessage(loginFailureMessage))
    }

    const sessionInfo = session.sessionInfo
    let wsToken = ''
    if (sessionInfo !== null) {
        const wsTokenResult = await tryInternal(
            () => generateWsToken(sessionInfo, String(user.id)),
            'Failed to generate WebSocket token',
        )
        if (Result.isError(wsTokenResult)) {
            return Result.err(wsTokenResult.error)
        }

        wsToken = wsTokenResult.value
    }

    const csrfToken = getSessionCsrfToken(sessionInfo)
    const payload: AuthSuccessPayload = {
        status: 'success',
        user: userTransformer.serialize(user),
        wsUrl: wsToken !== '' ? getWsUrl() : '',
        wsToken,
    }
    if (csrfToken !== undefined) {
        payload.csrfToken = csrfToken
    }
    return Result.ok(payload)
}

async function persistRegisteredUser(
    createUserInput: {
        name: string
        email: string | null
        phone: string | null
        passwordHash: string
    },
    options: {
        sendEmailVerification: boolean
        challengeIdToInvalidate?: string
    },
): Promise<AppResult<Awaited<ReturnType<typeof userRepository.create>>>> {
    const userCreatedResult = await tryInternal(
        () =>
            userRepository.create({
                name: createUserInput.name,
                email: createUserInput.email,
                phone: createUserInput.phone,
                password: createUserInput.passwordHash,
            }),
        'Failed to create user',
    )
    if (Result.isError(userCreatedResult)) {
        return Result.err(userCreatedResult.error)
    }

    const userCreated = userCreatedResult.value

    if (options.sendEmailVerification) {
        void emailVerificationService.sendVerificationEmailAfterRegistration(userCreated.id)
    }

    if (options.challengeIdToInvalidate !== undefined) {
        await smsAuthChallengeRepository.markInvalidated(options.challengeIdToInvalidate)
    }

    return Result.ok(userCreated)
}

async function finalizeRegistration(
    createUserInput: {
        name: string
        email: string | null
        phone: string | null
        passwordHash: string
    },
    auth: Auth,
    session: Session,
    options: {
        sendEmailVerification: boolean
        challengeIdToInvalidate?: string
        loginFailureMessage?: string
    },
): Promise<AppResult<AuthSuccessPayload>> {
    const persistOptions: {
        sendEmailVerification: boolean
        challengeIdToInvalidate?: string
    } = {
        sendEmailVerification: options.sendEmailVerification,
    }
    if (options.challengeIdToInvalidate !== undefined) {
        persistOptions.challengeIdToInvalidate = options.challengeIdToInvalidate
    }

    const userCreatedResult = await persistRegisteredUser(createUserInput, persistOptions)
    if (Result.isError(userCreatedResult)) {
        return Result.err(userCreatedResult.error)
    }

    const destroySessionResult = await tryInternal(
        () => session.destroySession(session.sessionInfo?.id),
        'Failed to destroy session',
    )
    if (Result.isError(destroySessionResult)) {
        return Result.err(destroySessionResult.error)
    }

    return await buildAuthSuccess(
        userCreatedResult.value,
        auth,
        session,
        options.loginFailureMessage ?? 'Failed to log in user',
    )
}

/**
 * Sends the verification mail again, in the background and at most once per interval per
 * account. Nothing here may change the answer of the login or delay it, and a failure (Redis
 * down, no mail transport) is only logged.
 */
async function resendVerificationAfterUnverifiedLogin(userId: bigint): Promise<void> {
    try {
        const throttle = await consumeAuthThrottle(
            throttlePolicies.loginUnverifiedResend,
            String(userId),
        )
        if (!throttle.allowed) return
        await emailVerificationService.sendVerificationEmailInBackground(userId, 'unverified login')
    } catch (err) {
        logger.warn({ err, userId: String(userId) }, 'Could not resend the verification mail')
    }
}

async function registerEmailFlow(
    payload: RegisterEmailInput,
    auth: Auth,
    session: Session,
    _loggerInstance: Logger,
    requestMeta: { ipAddress: string },
): Promise<AppResult<RegisterEmailFlowPayload>> {
    const { name, password } = payload
    const email = normalizeEmail(payload.email)

    const ipThrottle = await enforceThrottle(
        throttlePolicies.registerEmailIp,
        requestMeta.ipAddress,
        {
            unavailable: 'Failed to enforce email registration IP throttle',
            rejected: badRequest('Too many registration attempts. Please try again later.'),
        },
    )
    if (Result.isError(ipThrottle)) {
        return Result.err(ipThrottle.error)
    }

    const emailThrottle = await enforceThrottle(throttlePolicies.registerEmailIdentifier, email, {
        unavailable: 'Failed to enforce email registration identifier throttle',
        rejected: badRequest('Too many registration attempts. Please try again later.'),
    })
    if (Result.isError(emailThrottle)) {
        return Result.err(emailThrottle.error)
    }

    // Hashed before the address is looked up, so a taken address costs the same time as a new
    // one: otherwise the duration of the answer says whether the address is registered.
    const hashResult = await createPasswordHash(password)
    if (Result.isError(hashResult)) {
        return Result.err(hashResult.error)
    }

    const existResult = await tryInternal(
        () => userRepository.findByEmail(email),
        'Failed to load user by email',
    )
    if (Result.isError(existResult)) {
        return Result.err(existResult.error)
    }

    if (existResult.value !== undefined) {
        return Result.ok({
            status: 'success',
            message: GENERIC_EMAIL_REGISTRATION_MESSAGE,
        })
    }

    if (!authConfig.strictRegistration) {
        return await finalizeRegistration(
            {
                name,
                email,
                phone: null,
                passwordHash: hashResult.value,
            },
            auth,
            session,
            {
                sendEmailVerification: true,
            },
        )
    }

    const registeredUserResult = await persistRegisteredUser(
        {
            name,
            email,
            phone: null,
            passwordHash: hashResult.value,
        },
        {
            sendEmailVerification: true,
        },
    )
    if (Result.isError(registeredUserResult)) {
        return Result.err(registeredUserResult.error)
    }

    const destroySessionResult = await tryInternal(
        () => session.destroySession(session.sessionInfo?.id),
        'Failed to destroy session',
    )
    if (Result.isError(destroySessionResult)) {
        return Result.err(destroySessionResult.error)
    }

    return Result.ok({
        status: 'success',
        message: GENERIC_EMAIL_REGISTRATION_MESSAGE,
    })
}

export const authService = {
    async registerByEmail(
        payload: RegisterEmailInput,
        auth: Auth,
        session: Session,
        loggerInstance: Logger,
        requestMeta: { ipAddress: string },
    ): Promise<AppResult<RegisterEmailFlowPayload>> {
        return await registerEmailFlow(payload, auth, session, loggerInstance, requestMeta)
    },

    async startPhoneRegistration(
        payload: RegisterPhoneStartInput,
        requestMeta: { ipAddress: string; sessionId: string | null },
    ): Promise<
        AppResult<{
            status: 'success'
            challengeId: string
            expiresAt: string
            resendAvailableAt: string
        }>
    > {
        const gateResult = assertPhoneAuthEnabled()
        if (gateResult !== undefined) {
            return gateResult
        }

        const normalizedPhoneResult = normalizePhone(payload.phone, payload.defaultCountry)
        if (Result.isError(normalizedPhoneResult)) {
            return Result.err(normalizedPhoneResult.error)
        }

        const phone = normalizedPhoneResult.value

        const ipThrottle = await enforceThrottle(
            throttlePolicies.registerPhoneIp,
            requestMeta.ipAddress,
            {
                unavailable: 'Failed to enforce auth IP throttle',
                rejected: badRequest('Too many verification attempts. Please try again later.'),
            },
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        const phoneThrottle = await enforceThrottle(throttlePolicies.smsSendPhone, phone, {
            unavailable: 'Failed to enforce auth phone throttle',
            rejected: badRequest('Too many verification attempts. Please try again later.'),
        })
        if (Result.isError(phoneThrottle)) {
            return Result.err(phoneThrottle.error)
        }

        const existingUserResult = await tryInternal(
            () => userRepository.findByPhone(phone),
            'Failed to load user by phone',
        )
        if (Result.isError(existingUserResult)) {
            return Result.err(existingUserResult.error)
        }
        const collisionDetected = existingUserResult.value !== undefined

        const pendingChallengeResult = await tryInternal(
            () =>
                smsAuthChallengeRepository.findLatestPendingForPhoneFlow(
                    phone,
                    REGISTER_PHONE_FLOW,
                ),
            'Failed to load pending SMS auth challenge',
        )
        if (Result.isError(pendingChallengeResult)) {
            return Result.err(pendingChallengeResult.error)
        }
        if (
            pendingChallengeResult.value !== undefined &&
            pendingChallengeResult.value.resendAvailableAt.getTime() > Date.now()
        ) {
            return Result.err(
                buildResendCooldownError(pendingChallengeResult.value.resendAvailableAt),
            )
        }

        await smsAuthChallengeRepository.invalidatePendingForPhoneFlow(phone, REGISTER_PHONE_FLOW)

        const now = Date.now()
        const expiresAt = new Date(now + authConfig.smsChallengeTtlSeconds * 1000)
        const resendAvailableAt = new Date(now + authConfig.smsResendCooldownSeconds * 1000)

        const createdResult = await tryInternal(
            () =>
                smsAuthChallengeRepository.create({
                    flow: REGISTER_PHONE_FLOW,
                    phone,
                    codeHash: PENDING_SMS_CODE_HASH_PLACEHOLDER,
                    expiresAt,
                    resendAvailableAt,
                    providerRequestId: null,
                    metadata: {
                        ipAddress: requestMeta.ipAddress,
                        provider: authConfig.smsProvider,
                        ...(requestMeta.sessionId !== null
                            ? { sessionId: requestMeta.sessionId }
                            : {}),
                    },
                }),
            'Failed to persist SMS auth challenge',
        )
        if (Result.isError(createdResult)) {
            return Result.err(createdResult.error)
        }

        const issueCodeResult = await tryInternal(
            () =>
                smsVerificationProvider.issueVerificationCode({
                    phone,
                    flow: REGISTER_PHONE_FLOW,
                }),
            'Failed to issue SMS verification code',
        )
        if (Result.isError(issueCodeResult)) {
            await smsAuthChallengeRepository.markInvalidated(createdResult.value.id)
            return Result.err(issueCodeResult.error)
        }

        const issuedChallengeResult = await tryInternal(
            () =>
                smsAuthChallengeRepository.markIssued(createdResult.value.id, {
                    codeHash: hashOtpVerificationCode(issueCodeResult.value.code),
                    providerRequestId: issueCodeResult.value.providerRequestId,
                    metadata: {
                        ipAddress: requestMeta.ipAddress,
                        provider: authConfig.smsProvider,
                        ...(requestMeta.sessionId !== null
                            ? { sessionId: requestMeta.sessionId }
                            : {}),
                    },
                }),
            'Failed to persist issued SMS challenge',
        )
        if (Result.isError(issuedChallengeResult)) {
            await smsAuthChallengeRepository.markInvalidated(createdResult.value.id)
            return Result.err(issuedChallengeResult.error)
        }
        if (issuedChallengeResult.value === undefined) {
            await smsAuthChallengeRepository.markInvalidated(createdResult.value.id)
            return Result.err(badRequest('Phone registration challenge is no longer valid'))
        }

        if (collisionDetected) {
            logger.info(
                {
                    phoneMasked: maskPhoneForLogs(phone),
                    flow: REGISTER_PHONE_FLOW,
                    event: 'phone_auth_collision_detected',
                },
                'Phone registration collision detected',
            )
        }

        return Result.ok({
            status: 'success',
            challengeId: issuedChallengeResult.value.id,
            expiresAt: issuedChallengeResult.value.expiresAt.toISOString(),
            resendAvailableAt: issuedChallengeResult.value.resendAvailableAt.toISOString(),
        })
    },

    async confirmPhoneRegistration(
        payload: RegisterPhoneConfirmInput,
        requestMeta: { ipAddress: string },
    ): Promise<
        AppResult<{
            status: 'success'
            challengeId: string
            verified: true
        }>
    > {
        const gateResult = assertPhoneAuthEnabled()
        if (gateResult !== undefined) {
            return gateResult
        }

        const ipThrottle = await enforceThrottle(
            throttlePolicies.confirmPhoneIp,
            requestMeta.ipAddress,
            {
                unavailable: 'Failed to enforce phone confirmation IP throttle',
                rejected: badRequest('Too many verification attempts. Please try again later.'),
            },
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }
        const challengeResult = await tryInternal(
            () => smsAuthChallengeRepository.findById(payload.challengeId),
            'Failed to load SMS auth challenge',
        )
        if (Result.isError(challengeResult)) {
            return Result.err(challengeResult.error)
        }

        const challenge = challengeResult.value
        if (challenge?.flow !== REGISTER_PHONE_FLOW) {
            return Result.err(notFound('Challenge', 'Phone registration challenge not found'))
        }

        if (
            challenge.invalidatedAt !== null ||
            challenge.confirmedAt !== null ||
            isChallengeExpired(challenge.expiresAt)
        ) {
            return Result.err(badRequest('Phone registration challenge is no longer valid'))
        }

        if (!verifyOtpVerificationCode(payload.code, challenge.codeHash)) {
            const updatedChallenge = await smsAuthChallengeRepository.incrementAttemptCount(
                challenge.id,
            )
            if (
                (updatedChallenge?.attemptCount ?? challenge.attemptCount + 1) >=
                authConfig.smsMaxInvalidAttempts
            ) {
                await smsAuthChallengeRepository.markInvalidated(challenge.id)
            }

            return Result.err(badRequest('Invalid verification code'))
        }

        const confirmedResult = await tryInternal(
            () => smsAuthChallengeRepository.markConfirmed(challenge.id),
            'Failed to confirm SMS auth challenge',
        )
        if (Result.isError(confirmedResult)) {
            return Result.err(confirmedResult.error)
        }
        if (confirmedResult.value === undefined) {
            return Result.err(badRequest('Phone registration challenge is no longer valid'))
        }

        return Result.ok({
            status: 'success',
            challengeId: challenge.id,
            verified: true,
        })
    },

    async completePhoneRegistration(
        payload: RegisterPhoneCompleteInput,
        auth: Auth,
        session: Session,
        _loggerInstance: Logger,
        requestMeta: { sessionId: string | null },
    ): Promise<AppResult<AuthSuccessPayload>> {
        const gateResult = assertPhoneAuthEnabled()
        if (gateResult !== undefined) {
            return gateResult
        }

        const challengeResult = await tryInternal(
            () => smsAuthChallengeRepository.findById(payload.challengeId),
            'Failed to load SMS auth challenge',
        )
        if (Result.isError(challengeResult)) {
            return Result.err(challengeResult.error)
        }

        const challenge = challengeResult.value
        if (challenge?.flow !== REGISTER_PHONE_FLOW) {
            return Result.err(notFound('Challenge', 'Phone registration challenge not found'))
        }

        if (
            challenge.invalidatedAt !== null ||
            challenge.confirmedAt === null ||
            isChallengeExpired(challenge.expiresAt)
        ) {
            return Result.err(
                badRequest(
                    'Phone registration challenge must be confirmed before completing registration',
                ),
            )
        }

        const challengeSessionId = extractChallengeSessionId(challenge.metadata)
        if (
            challengeSessionId === null ||
            requestMeta.sessionId === null ||
            challengeSessionId !== requestMeta.sessionId
        ) {
            return Result.err(
                badRequest('Phone registration challenge must be completed from the same session'),
            )
        }

        const existingUserResult = await tryInternal(
            () => userRepository.findByPhone(challenge.phone),
            'Failed to load user by phone',
        )
        if (Result.isError(existingUserResult)) {
            return Result.err(existingUserResult.error)
        }
        if (existingUserResult.value !== undefined) {
            return Result.err(conflict('Phone already exist'))
        }

        const hashResult = await createPasswordHash(payload.password)
        if (Result.isError(hashResult)) {
            return Result.err(hashResult.error)
        }

        return await finalizeRegistration(
            {
                name: payload.name,
                email: null,
                phone: challenge.phone,
                passwordHash: hashResult.value,
            },
            auth,
            session,
            {
                sendEmailVerification: false,
                challengeIdToInvalidate: challenge.id,
            },
        )
    },

    async startPhoneLink(
        userId: bigint,
        payload: LinkPhoneStartInput,
        requestMeta: { ipAddress: string; sessionId: string | null },
    ): Promise<
        AppResult<{
            status: 'success'
            challengeId: string
            expiresAt: string
            resendAvailableAt: string
        }>
    > {
        const gateResult = assertPhoneAuthEnabled()
        if (gateResult !== undefined) {
            return gateResult
        }

        if (requestMeta.sessionId === null) {
            return Result.err(badRequest('Phone linking requires an active session'))
        }

        const reauthResult = await requireCurrentPasswordReauth(userId, payload.currentPassword)
        if (Result.isError(reauthResult)) {
            return Result.err(reauthResult.error)
        }

        const user = reauthResult.value
        if (user.phone !== null && user.phone !== '') {
            return Result.err(badRequest('Phone is already linked to this account'))
        }

        const normalizedPhoneResult = normalizePhone(payload.phone, payload.defaultCountry)
        if (Result.isError(normalizedPhoneResult)) {
            return Result.err(normalizedPhoneResult.error)
        }

        const phone = normalizedPhoneResult.value

        const ipThrottle = await enforceThrottle(
            throttlePolicies.linkPhoneIp,
            requestMeta.ipAddress,
            {
                unavailable: 'Failed to enforce phone linking IP throttle',
                rejected: badRequest('Too many verification attempts. Please try again later.'),
            },
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        const phoneThrottle = await enforceThrottle(throttlePolicies.smsSendPhone, phone, {
            unavailable: 'Failed to enforce phone linking identifier throttle',
            rejected: badRequest('Too many verification attempts. Please try again later.'),
        })
        if (Result.isError(phoneThrottle)) {
            return Result.err(phoneThrottle.error)
        }

        const phoneExistsResult = await tryInternal(
            () => userRepository.phoneExistsForOtherUser(phone, userId),
            'Failed to validate phone ownership',
        )
        if (Result.isError(phoneExistsResult)) {
            return Result.err(phoneExistsResult.error)
        }
        if (phoneExistsResult.value) {
            return Result.err(conflict('Phone is already linked to another account'))
        }

        const pendingChallengeResult = await tryInternal(
            () => smsAuthChallengeRepository.findLatestPendingForPhoneFlow(phone, LINK_PHONE_FLOW),
            'Failed to load pending phone linking challenge',
        )
        if (Result.isError(pendingChallengeResult)) {
            return Result.err(pendingChallengeResult.error)
        }
        if (
            pendingChallengeResult.value !== undefined &&
            pendingChallengeResult.value.resendAvailableAt.getTime() > Date.now()
        ) {
            return Result.err(
                buildResendCooldownError(pendingChallengeResult.value.resendAvailableAt),
            )
        }

        await smsAuthChallengeRepository.invalidatePendingForPhoneFlow(phone, LINK_PHONE_FLOW)

        const now = Date.now()
        const expiresAt = new Date(now + authConfig.smsChallengeTtlSeconds * 1000)
        const resendAvailableAt = new Date(now + authConfig.smsResendCooldownSeconds * 1000)

        const createdResult = await tryInternal(
            () =>
                smsAuthChallengeRepository.create({
                    flow: LINK_PHONE_FLOW,
                    phone,
                    codeHash: PENDING_SMS_CODE_HASH_PLACEHOLDER,
                    expiresAt,
                    resendAvailableAt,
                    providerRequestId: null,
                    metadata: {
                        userId: String(userId),
                        ipAddress: requestMeta.ipAddress,
                        provider: authConfig.smsProvider,
                        sessionId: requestMeta.sessionId,
                    },
                }),
            'Failed to persist phone linking challenge',
        )
        if (Result.isError(createdResult)) {
            return Result.err(createdResult.error)
        }

        const issueCodeResult = await tryInternal(
            () =>
                smsVerificationProvider.issueVerificationCode({
                    phone,
                    flow: LINK_PHONE_FLOW,
                }),
            'Failed to issue SMS verification code',
        )
        if (Result.isError(issueCodeResult)) {
            await smsAuthChallengeRepository.markInvalidated(createdResult.value.id)
            return Result.err(issueCodeResult.error)
        }

        const issuedChallengeResult = await tryInternal(
            () =>
                smsAuthChallengeRepository.markIssued(createdResult.value.id, {
                    codeHash: hashOtpVerificationCode(issueCodeResult.value.code),
                    providerRequestId: issueCodeResult.value.providerRequestId,
                    metadata: {
                        userId: String(userId),
                        ipAddress: requestMeta.ipAddress,
                        provider: authConfig.smsProvider,
                        sessionId: requestMeta.sessionId,
                    },
                }),
            'Failed to persist issued phone linking challenge',
        )
        if (Result.isError(issuedChallengeResult)) {
            await smsAuthChallengeRepository.markInvalidated(createdResult.value.id)
            return Result.err(issuedChallengeResult.error)
        }
        if (issuedChallengeResult.value === undefined) {
            await smsAuthChallengeRepository.markInvalidated(createdResult.value.id)
            return Result.err(badRequest('Phone linking challenge is no longer valid'))
        }

        return Result.ok({
            status: 'success',
            challengeId: issuedChallengeResult.value.id,
            expiresAt: issuedChallengeResult.value.expiresAt.toISOString(),
            resendAvailableAt: issuedChallengeResult.value.resendAvailableAt.toISOString(),
        })
    },

    async confirmPhoneLink(
        userId: bigint,
        payload: LinkPhoneConfirmInput,
        requestMeta: { ipAddress: string; sessionId: string | null },
    ): Promise<
        AppResult<{
            status: 'success'
            message: string
            user: ReturnType<typeof userTransformer.serialize>
        }>
    > {
        const gateResult = assertPhoneAuthEnabled()
        if (gateResult !== undefined) {
            return gateResult
        }

        const ipThrottle = await enforceThrottle(
            throttlePolicies.confirmLinkPhoneIp,
            requestMeta.ipAddress,
            {
                unavailable: 'Failed to enforce phone linking confirmation IP throttle',
                rejected: badRequest('Too many verification attempts. Please try again later.'),
            },
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        const challengeResult = await tryInternal(
            () => smsAuthChallengeRepository.findById(payload.challengeId),
            'Failed to load SMS auth challenge',
        )
        if (Result.isError(challengeResult)) {
            return Result.err(challengeResult.error)
        }

        const challenge = challengeResult.value
        if (challenge?.flow !== LINK_PHONE_FLOW) {
            return Result.err(notFound('Challenge', 'Phone linking challenge not found'))
        }

        const challengeUserId = extractChallengeUserId(challenge.metadata)
        if (challengeUserId !== userId) {
            return Result.err(unauthorized('Challenge does not belong to this account'))
        }

        const challengeSessionId = extractChallengeSessionId(challenge.metadata)
        if (
            challengeSessionId === null ||
            requestMeta.sessionId === null ||
            challengeSessionId !== requestMeta.sessionId
        ) {
            return Result.err(
                badRequest('Phone linking challenge must be confirmed from the same session'),
            )
        }

        if (
            challenge.invalidatedAt !== null ||
            challenge.confirmedAt !== null ||
            isChallengeExpired(challenge.expiresAt)
        ) {
            return Result.err(badRequest('Phone linking challenge is no longer valid'))
        }

        if (!verifyOtpVerificationCode(payload.code, challenge.codeHash)) {
            const updatedChallenge = await smsAuthChallengeRepository.incrementAttemptCount(
                challenge.id,
            )
            if (
                (updatedChallenge?.attemptCount ?? challenge.attemptCount + 1) >=
                authConfig.smsMaxInvalidAttempts
            ) {
                await smsAuthChallengeRepository.markInvalidated(challenge.id)
            }

            return Result.err(badRequest('Invalid verification code'))
        }

        const userResult = await tryInternal(
            () => userRepository.findById(userId),
            'Failed to load user',
        )
        if (Result.isError(userResult)) {
            return Result.err(userResult.error)
        }
        const user = userResult.value
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }
        if (user.phone !== null && user.phone !== '') {
            return Result.err(badRequest('Phone is already linked to this account'))
        }

        const phoneExistsResult = await tryInternal(
            () => userRepository.phoneExistsForOtherUser(challenge.phone, userId),
            'Failed to validate phone ownership',
        )
        if (Result.isError(phoneExistsResult)) {
            return Result.err(phoneExistsResult.error)
        }
        if (phoneExistsResult.value) {
            return Result.err(conflict('Phone is already linked to another account'))
        }

        const confirmedResult = await tryInternal(
            () => smsAuthChallengeRepository.markConfirmed(challenge.id),
            'Failed to confirm phone linking challenge',
        )
        if (Result.isError(confirmedResult)) {
            return Result.err(confirmedResult.error)
        }
        if (confirmedResult.value === undefined) {
            return Result.err(badRequest('Phone linking challenge is no longer valid'))
        }

        const updatedUserResult = await tryInternal(
            () => userRepository.update(userId, { phone: challenge.phone }),
            'Failed to link phone to user account',
        )
        if (Result.isError(updatedUserResult)) {
            return Result.err(updatedUserResult.error)
        }

        const updatedUser = updatedUserResult.value
        if (updatedUser === undefined) {
            return Result.err(internalMessage('Failed to link phone to user account'))
        }

        return Result.ok({
            status: 'success',
            message: 'Phone linked successfully',
            user: userTransformer.serialize(updatedUser),
        })
    },

    async startEmailLink(
        userId: bigint,
        payload: LinkEmailStartInput,
    ): Promise<AppResult<{ status: 'success'; message: string }>> {
        const reauthResult = await requireCurrentPasswordReauth(userId, payload.currentPassword)
        if (Result.isError(reauthResult)) {
            return Result.err(reauthResult.error)
        }

        const user = reauthResult.value
        if (user.email !== null && user.email !== '') {
            return Result.err(badRequest('Email is already linked to this account'))
        }

        const email = normalizeEmail(payload.email)

        const targetThrottle = await enforceThrottle(throttlePolicies.linkEmailTarget, email, {
            unavailable: 'Failed to enforce email linking target throttle',
            rejected: badRequest('Too many verification attempts. Please try again later.'),
        })
        if (Result.isError(targetThrottle)) {
            return Result.err(targetThrottle.error)
        }

        const userThrottle = await enforceThrottle(throttlePolicies.linkEmailUser, String(userId), {
            unavailable: 'Failed to enforce email linking user throttle',
            rejected: badRequest('Too many verification attempts. Please try again later.'),
        })
        if (Result.isError(userThrottle)) {
            return Result.err(userThrottle.error)
        }

        const userCooldown = await enforceThrottle(
            throttlePolicies.linkEmailUserCooldown,
            String(userId),
            {
                unavailable: 'Failed to enforce email linking cooldown',
                rejected: badRequest('Too many verification attempts. Please try again later.'),
            },
        )
        if (Result.isError(userCooldown)) {
            return Result.err(userCooldown.error)
        }

        const emailExistsResult = await tryInternal(
            () => userRepository.emailExistsForOtherUser(email, userId),
            'Failed to validate email ownership',
        )
        if (Result.isError(emailExistsResult)) {
            return Result.err(emailExistsResult.error)
        }
        if (emailExistsResult.value) {
            return Result.err(conflict('Email is already linked to another account'))
        }

        const sendResult = await emailVerificationService.sendLinkVerificationEmail(userId, email)
        if (Result.isError(sendResult)) {
            return Result.err(sendResult.error)
        }

        return Result.ok({
            status: 'success',
            message: sendResult.value.message,
        })
    },

    async login(
        payload: LoginInput,
        auth: Auth,
        session: Session,
        requestMeta: { ipAddress: string },
    ): Promise<AppResult<AuthSuccessPayload>> {
        const { password } = payload
        const invalidCredentials = (): AppResult<never> =>
            Result.err(unauthorized('Invalid email or password'))
        const loginKey = resolveLoginKey(resolveLoginIdentifier(payload))

        // Consume before the lookup: same cost for every outcome, no check/increment race. A spent
        // counter answers like a wrong password: nothing tells the two apart.
        const ipThrottle = await enforceThrottle(throttlePolicies.loginIp, requestMeta.ipAddress, {
            unavailable: 'Failed to enforce login IP throttle',
            rejected: unauthorized('Invalid email or password'),
        })
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        if (loginKey === null) {
            return invalidCredentials()
        }

        const identifierThrottle = await enforceThrottle(
            throttlePolicies.loginIdentifier,
            loginKey.value,
            {
                unavailable: 'Failed to enforce login identifier throttle',
                rejected: unauthorized('Invalid email or password'),
            },
        )
        if (Result.isError(identifierThrottle)) {
            return Result.err(identifierThrottle.error)
        }

        const userResult = await tryInternal(
            () =>
                loginKey.kind === 'email'
                    ? userRepository.findByEmail(loginKey.value)
                    : userRepository.findByPhone(loginKey.value),
            `Failed to load user by ${loginKey.kind}`,
        )
        if (Result.isError(userResult)) {
            return Result.err(userResult.error)
        }

        const user = userResult.value
        if (user === undefined) {
            return invalidCredentials()
        }

        // Same answer as a wrong password: do not reveal that an OAuth-only account exists.
        const passwordHash = user.password
        if (passwordHash === null || passwordHash === '') {
            return invalidCredentials()
        }

        const validResult = await tryInternal(
            () => validatePassword(password, passwordHash),
            'Failed to validate password',
        )
        if (Result.isError(validResult)) {
            return Result.err(validResult.error)
        }

        if (!validResult.value) {
            return invalidCredentials()
        }

        // The right password of an account that is not verified yet answers exactly what a
        // wrong password answers: a distinct answer would tell anyone who guesses the password
        // that the account exists and the guess is right. It counts as a failed attempt (the
        // budget below is not reset). The owner, who knows the password, gets the mail again.
        if (
            loginKey.kind === 'email' &&
            authConfig.strictRegistration &&
            user.emailVerifiedAt === null
        ) {
            void resendVerificationAfterUnverifiedLogin(user.id)
            return invalidCredentials()
        }

        // The correct password resets the per-account budget; the IP budget stays.
        const resetResult = await tryInternal(
            () => resetAuthThrottle(throttlePolicies.loginIdentifier, loginKey.value),
            'Failed to reset login identifier throttle',
        )
        if (Result.isError(resetResult)) {
            logger.warn({ err: resetResult.error }, 'Login throttle reset failed')
        }

        const success = await buildAuthSuccess(user, auth, session)
        if (Result.isOk(success)) userNotificationService.security(user.id, 'new_sign_in')
        return success
    },

    async logout(
        auth: Auth,
        session: Session,
    ): Promise<AppResult<{ status: 'success'; csrfToken: string }>> {
        const result = await tryInternal(() => auth.logout(), 'Failed to log out user')
        if (Result.isError(result)) {
            return Result.err(result.error)
        }

        if (!result.value) {
            return Result.err(internalMessage('Failed to log out user'))
        }

        const csrfToken = getSessionCsrfToken(session.sessionInfo)
        if (csrfToken === undefined) {
            return Result.err(internalMessage('Missing rotated CSRF token'))
        }

        return Result.ok({
            status: 'success',
            csrfToken,
        })
    },

    /**
     * New session ID and CSRF token for the same user, e.g. after a password change
     * (OWASP: renew the session ID on any change of credentials). The previous
     * session is deleted, so its cookie and token stop working.
     */
    async renewSession(
        auth: Auth,
        session: Session,
        // After a credential change the user has a rotated sessionToken (ADR 0002);
        // the new session is issued under it, not under the one it replaces.
        rotatedUserToken?: string,
    ): Promise<AppResult<{ csrfToken: string; wsUrl: string; wsToken: string }>> {
        const userId = auth.getUserId()
        const userToken = rotatedUserToken ?? session.sessionInfo?.data.userToken
        if (userId === null || typeof userToken !== 'string') {
            return Result.err(internalMessage('No signed-in session to renew'))
        }

        const result = await tryInternal(
            () => auth.login(userId, userToken),
            'Failed to renew session',
        )
        if (Result.isError(result)) {
            return Result.err(result.error)
        }

        const sessionInfo = session.sessionInfo
        const csrfToken = getSessionCsrfToken(sessionInfo)
        if (sessionInfo === null || csrfToken === undefined) {
            return Result.err(internalMessage('Missing rotated CSRF token'))
        }
        // The open WebSocket is bound to the deleted session: the client reconnects
        // with this token.
        const wsTokenResult = await tryInternal(
            () => generateWsToken(sessionInfo, userId),
            'Failed to generate WebSocket token',
        )
        if (Result.isError(wsTokenResult)) {
            return Result.err(wsTokenResult.error)
        }
        return Result.ok({ csrfToken, wsUrl: getWsUrl(), wsToken: wsTokenResult.value })
    },

    async logoutAll(
        auth: Auth,
        session: Session,
    ): Promise<AppResult<{ status: 'success'; deletedCount: number; csrfToken: string }>> {
        const userId = auth.getUserId()
        // ADR 0002: rotating the sessionToken is the revocation. It comes first and its
        // failure fails the request; auth.logoutAll() below only deletes the records,
        // and every one of them is already rejected if that step fails.
        if (userId !== null) {
            const rotated = await tryInternal(
                () => userRepository.update(BigInt(userId), { sessionToken: nanoid() }),
                'Failed to revoke sessions',
            )
            if (Result.isError(rotated)) {
                return Result.err(rotated.error)
            }
            if (rotated.value === undefined) {
                return Result.err(notFound('User', 'User not found'))
            }
        }
        const result = await tryInternal(() => auth.logoutAll(), 'Failed to log out all sessions')
        if (Result.isError(result)) {
            return Result.err(result.error)
        }
        if (userId !== null) userNotificationService.security(BigInt(userId), 'logout_all')

        const csrfToken = getSessionCsrfToken(session.sessionInfo)
        if (csrfToken === undefined) {
            return Result.err(internalMessage('Missing rotated CSRF token'))
        }

        return Result.ok({
            status: 'success',
            deletedCount: result.value,
            csrfToken,
        })
    },

    async changePassword(
        userId: bigint,
        payload: ChangePasswordInput,
    ): Promise<AppResult<{ status: 'success'; sessionToken: string }>> {
        // Consumed before the current-password check, same scheme as login.
        const throttle = await enforceThrottle(
            throttlePolicies.changePasswordUser,
            String(userId),
            {
                unavailable: 'Failed to enforce change password throttle',
                rejected: badRequest('Too many password change attempts. Please try again later.'),
            },
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }

        const userResult = await tryInternal(
            () => userRepository.findById(userId),
            'Failed to load user',
        )
        if (Result.isError(userResult)) {
            return Result.err(userResult.error)
        }

        const user = userResult.value
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }

        const storedPassword = user.password
        const hasPassword = storedPassword !== null && storedPassword !== ''
        if (hasPassword) {
            if (payload.currentPassword === undefined || payload.currentPassword === '') {
                return Result.err(badRequest('Current password is required'))
            }

            const currentPassword = payload.currentPassword
            const validResult = await tryInternal(
                () => validatePassword(currentPassword, storedPassword),
                'Failed to validate current password',
            )
            if (Result.isError(validResult)) {
                return Result.err(validResult.error)
            }

            if (!validResult.value) {
                return Result.err(badRequest('Current password is incorrect'))
            }
        }

        const newPasswordHashResult = await tryInternal(
            () => hashPassword(payload.newPassword),
            'Failed to hash password',
        )
        if (Result.isError(newPasswordHashResult)) {
            return Result.err(newPasswordHashResult.error)
        }

        // ADR 0002: the new password and the rotated sessionToken are one conditional
        // UPDATE. Every other session of the user stops working with it, whether or not
        // the Redis cleanup below finishes; and of two concurrent changes made against
        // the same current password only one finds it still in place.
        const previousSessionToken = user.sessionToken
        const rotatedSessionToken = nanoid()
        const updatedResult = await tryInternal(
            () =>
                userRepository.changePasswordIfCurrent(userId, storedPassword, {
                    password: newPasswordHashResult.value,
                    sessionToken: rotatedSessionToken,
                }),
            'Failed to update password',
        )
        if (Result.isError(updatedResult)) {
            return Result.err(updatedResult.error)
        }

        if (updatedResult.value === undefined) {
            return Result.err(
                conflict('Password was changed by another request. Please try again.'),
            )
        }

        const resetResult = await tryInternal(
            () => resetAuthThrottle(throttlePolicies.changePasswordUser, String(userId)),
            'Failed to reset change password throttle',
        )
        if (Result.isError(resetResult)) {
            logger.warn({ err: resetResult.error }, 'Change password throttle reset failed')
        }

        // Memory cleanup, not the revocation: a failure leaves records that are already
        // rejected, so it is logged and the password change still succeeds.
        const cleanupResult = await tryInternal(
            () => destroyAllSessions(previousSessionToken),
            'Failed to delete previous sessions',
        )
        if (Result.isError(cleanupResult)) {
            logger.warn(
                { err: cleanupResult.error, userId: String(userId) },
                'Previous sessions not deleted after a password change',
            )
        }

        userNotificationService.security(userId, 'password_changed')
        return Result.ok({ status: 'success', sessionToken: rotatedSessionToken })
    },
}
