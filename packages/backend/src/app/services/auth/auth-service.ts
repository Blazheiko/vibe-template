import { hashPassword, validatePassword } from 'metautil'
import { Result } from 'better-result'
import { nanoid } from 'nanoid'
import type { Auth, Session } from '#vendor/types/types.js'
import {
    passwordResetRepository,
    smsAuthChallengeRepository,
    userRepository,
    withTransaction,
} from '#app/repositories/index.js'
import type { UserRow } from '#app/repositories/index.js'
import { userTransformer } from '#app/transformers/index.js'
import {
    badRequest,
    conflict,
    internalMessage,
    sessionRevoked,
    notFound,
    rateLimited,
    unauthorized,
    type AppResult,
} from '#app/services/shared/errors.js'
import { generateWsToken } from '#app/services/auth/generate-ws-token-service.js'
import { getWsUrl } from '#app/services/communication/get-ws-url-service.js'
import { emailVerificationService } from '#app/services/auth/email-verification-service.js'
import { isUniqueViolation } from '#app/repositories/db-errors.js'
import { getDummyPasswordHash } from '#app/services/auth/dummy-password-hash.js'
import logger from '#vendor/utils/logger.js'
import { maskPhoneForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { authConfig } from '#config/auth.js'
import { consumeAuthThrottle, resetAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import { enforceEmailLinkThrottles, enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { invalidatePendingPhoneChallenges } from '#app/services/auth/phone-challenges.js'
import {
    confirmChallenge,
    findPendingChallenge,
    issueSmsChallenge,
    verifySmsCode,
} from '#app/services/auth/sms-challenge.js'
import {
    isChallengeExpired,
    LINK_PHONE_FLOW,
    normalizeEmail,
    normalizePhone,
    REGISTER_PHONE_FLOW,
} from '#app/services/auth/auth-normalize.js'
import { throttlePolicies, type ThrottlePolicy } from '#config/throttle-policies.js'
import {
    extractChallengeSessionId,
    extractChallengeUserId,
} from '#app/services/auth/sms-auth-challenge-metadata.js'
import { looksLikePhoneNumber } from 'shared/utils'
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
import { wsSessionRevocation } from '#app/services/auth/ws-session-revocation.js'

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

const genericEmailRegistrationAnswer = (): AppResult<GenericAcceptedPayload> =>
    Result.ok({ status: 'success', message: GENERIC_EMAIL_REGISTRATION_MESSAGE })

/**
 * The registration lost a race: the email or phone was taken after the lookup (feat-100).
 * Compared by reference; each caller turns it into its own answer and never returns it as is.
 */
const REGISTRATION_TAKEN = conflict('Registration identifier already taken')

const isRegistrationTaken = (error: unknown): boolean => error === REGISTRATION_TAKEN

function assertPhoneAuthEnabled(): AppResult<never> | undefined {
    if (authConfig.phoneAuthEnabled) {
        return undefined
    }

    return Result.err(badRequest('Phone authentication is disabled'))
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

/** The hourly SMS budget of a number, for the start that opens its challenge (feat-214). */
function spendSmsBudget(phone: string): Promise<AppResult<void>> {
    return enforceThrottle(
        throttlePolicies.smsSendPhone,
        phone,
        rateLimited('Too many verification attempts. Please try again later.'),
    )
}

// A correct password resets the per-account budget. Best effort: a failure here must not
// fail the sign-in or the password change that already succeeded.
async function resetThrottleQuietly(
    policy: ThrottlePolicy,
    key: string,
    step: 'Login' | 'Change password' | 'Password re-check',
): Promise<void> {
    try {
        await resetAuthThrottle(policy, key)
    } catch (err: unknown) {
        logger.warn({ err }, `${step} throttle reset failed`)
    }
}

/**
 * The user, once the request's session is still current and the password is right.
 * `presentedSessionToken` is `Auth.getPresentedUserToken()`: a session revoked after the
 * request was let in (a claim, a password change elsewhere) is refused here (feat-096).
 */
/**
 * feat-123 (L5): a logout in another tab deletes this session's record without rotating
 * users.session_token. An operation that does not write to the session asks right before its
 * irreversible step (a mail, an SMS, a link) whether the record is still there, and stops with 401.
 */
type SessionStillStored = () => Promise<boolean>

async function requireSessionStored(sessionStored: SessionStillStored): Promise<AppResult<void>> {
    if (!(await sessionStored())) {
        return Result.err(sessionRevoked())
    }
    return Result.ok(undefined)
}

async function requireCurrentPasswordReauth(
    userId: bigint,
    currentPassword: string,
    presentedSessionToken: string | undefined,
): Promise<AppResult<UserRow>> {
    const user = await userRepository.findById(userId)
    if (user === undefined) {
        return Result.err(notFound('User', 'User not found'))
    }
    if (presentedSessionToken === undefined || user.sessionToken !== presentedSessionToken) {
        return Result.err(sessionRevoked())
    }

    const passwordHash = user.password
    if (passwordHash === null || passwordHash === '') {
        return Result.err(badRequest('Set a password before managing recovery methods'))
    }

    // feat-109: spent before the check, from the same per-user budget as change-password, so a
    // stolen session cannot guess the password through link-email / link-phone from many IPs.
    const throttle = await enforceThrottle(
        throttlePolicies.changePasswordUser,
        String(userId),
        // feat-123: 429, as the R06b acceptance criteria say: a spent budget is a rate limit.
        rateLimited('Too many password attempts. Please try again later.'),
    )
    if (Result.isError(throttle)) {
        return Result.err(throttle.error)
    }

    const validResult = await validatePassword(currentPassword, passwordHash)

    if (!validResult) {
        return Result.err(badRequest('Current password is incorrect'))
    }

    await resetThrottleQuietly(
        throttlePolicies.changePasswordUser,
        String(userId),
        'Password re-check',
    )

    return Result.ok(user)
}

async function buildAuthSuccess(
    user: Awaited<ReturnType<typeof userRepository.create>>,
    auth: Auth,
    session: Session,
    loginFailureMessage = 'Failed to log in user',
): Promise<AppResult<AuthSuccessPayload>> {
    const loggedInResult = await auth.login(String(user.id), user.sessionToken)

    if (!loggedInResult) {
        return Result.err(internalMessage(loginFailureMessage))
    }

    const sessionInfo = session.sessionInfo
    let wsToken = ''
    if (sessionInfo !== null) {
        const wsTokenResult = await generateWsToken(sessionInfo, String(user.id))

        wsToken = wsTokenResult
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
    let userCreated: Awaited<ReturnType<typeof userRepository.create>>
    try {
        userCreated = await userRepository.create({
            name: createUserInput.name,
            email: createUserInput.email,
            phone: createUserInput.phone,
            password: createUserInput.passwordHash,
        })
    } catch (err: unknown) {
        // feat-100: a concurrent registration took the email or phone between the lookup and
        // this insert. Any unique violation is read as that: a registration fills only one of
        // email/phone, and the other unique column, session_token, is a random nanoid. A new
        // unique column filled at registration would have to check the index name here.
        // Caught before the mail, the challenge, the session and the login: no side effects.
        if (isUniqueViolation(err)) {
            return Result.err(REGISTRATION_TAKEN)
        }
        throw err
    }

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

    await session.destroySession()

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
        // feat-203 (L-2): the interval alone allowed 12 mails an hour, 288 a day, to an address
        // somebody else may have registered. This path spends the same hourly budget as the
        // resend button, and the daily one.
        for (const policy of [
            throttlePolicies.resendVerificationUser,
            throttlePolicies.verificationMailUserDaily,
        ]) {
            if (!(await consumeAuthThrottle(policy, String(userId))).allowed) return
        }
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
        rateLimited('Too many registration attempts. Please try again later.'),
    )
    if (Result.isError(ipThrottle)) {
        return Result.err(ipThrottle.error)
    }

    const emailThrottle = await enforceThrottle(
        throttlePolicies.registerEmailIdentifier,
        email,
        rateLimited('Too many registration attempts. Please try again later.'),
    )
    if (Result.isError(emailThrottle)) {
        return Result.err(emailThrottle.error)
    }

    // Hashed before the address is looked up, so a taken address costs the same time as a new
    // one: otherwise the duration of the answer says whether the address is registered.
    const passwordHash = await hashPassword(password)

    // feat-157: in strict mode the answer is the same whatever the address is, and so is what
    // happens to the caller's stored session: it ends in every branch. It used to end only
    // when the address was free, which told the caller whether the email was registered. (The
    // non-strict mode signs a free address in, so it has nothing to hide here.)
    const answerStrict = async (): Promise<AppResult<RegisterEmailFlowPayload>> => {
        await session.destroySession()
        return genericEmailRegistrationAnswer()
    }

    const existResult = await userRepository.findByEmail(email)

    if (existResult !== undefined) {
        return authConfig.strictRegistration
            ? await answerStrict()
            : genericEmailRegistrationAnswer()
    }

    if (!authConfig.strictRegistration) {
        const registered = await finalizeRegistration(
            {
                name,
                email,
                phone: null,
                passwordHash,
            },
            auth,
            session,
            {
                sendEmailVerification: true,
            },
        )
        // Lost the race to a concurrent registration: answered like a taken address.
        if (Result.isError(registered) && isRegistrationTaken(registered.error)) {
            return genericEmailRegistrationAnswer()
        }
        return registered
    }

    const registeredUserResult = await persistRegisteredUser(
        {
            name,
            email,
            phone: null,
            passwordHash,
        },
        {
            sendEmailVerification: true,
        },
    )
    if (Result.isError(registeredUserResult)) {
        if (isRegistrationTaken(registeredUserResult.error)) {
            // Lost the race to a concurrent registration: like a taken address.
            return await answerStrict()
        }
        return Result.err(registeredUserResult.error)
    }

    return await answerStrict()
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
            rateLimited('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        const existingUser = await userRepository.findByPhone(phone)
        const collisionDetected = existingUser !== undefined

        const pendingChallengeResult = await findPendingChallenge(phone, REGISTER_PHONE_FLOW)
        if (Result.isError(pendingChallengeResult)) {
            return Result.err(pendingChallengeResult.error)
        }

        const issuedChallengeResult = await issueSmsChallenge({
            phone,
            // feat-214: the hourly SMS budget of the number, spent under the lock by the start
            // that opens a challenge. Spent before it, a start the cooldown refused paid too.
            spendBudget: () => spendSmsBudget(phone),
            flow: REGISTER_PHONE_FLOW,
            metadata: {
                ipAddress: requestMeta.ipAddress,
                provider: authConfig.smsProvider,
                ...(requestMeta.sessionId !== null ? { sessionId: requestMeta.sessionId } : {}),
            },
            noLongerValid: 'Phone registration challenge is no longer valid',
        })
        if (Result.isError(issuedChallengeResult)) {
            return Result.err(issuedChallengeResult.error)
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
            rateLimited('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }
        const challenge = await smsAuthChallengeRepository.findById(payload.challengeId)
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

        const codeResult = await verifySmsCode(challenge, payload.code, {
            noLongerValid: 'Phone registration challenge is no longer valid',
        })
        if (Result.isError(codeResult)) {
            return Result.err(codeResult.error)
        }

        const confirmedResult = await confirmChallenge(challenge, {
            noLongerValid: 'Phone registration challenge is no longer valid',
        })
        if (Result.isError(confirmedResult)) {
            return Result.err(confirmedResult.error)
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

        const challenge = await smsAuthChallengeRepository.findById(payload.challengeId)
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

        const existingUser = await userRepository.findByPhone(challenge.phone)
        if (existingUser !== undefined) {
            return Result.err(conflict('Phone already exist'))
        }

        const passwordHash = await hashPassword(payload.password)

        const registered = await finalizeRegistration(
            {
                name: payload.name,
                email: null,
                phone: challenge.phone,
                passwordHash,
            },
            auth,
            session,
            {
                sendEmailVerification: false,
                challengeIdToInvalidate: challenge.id,
            },
        )
        // Another registration took the number after the check above: the same answer.
        if (Result.isError(registered) && isRegistrationTaken(registered.error)) {
            return Result.err(conflict('Phone already exist'))
        }
        return registered
    },

    async startPhoneLink(
        userId: bigint,
        payload: LinkPhoneStartInput,
        requestMeta: {
            ipAddress: string
            sessionId: string | null
            presentedSessionToken: string | undefined
            /** feat-123: checked right before the irreversible step. */
            sessionStored: SessionStillStored
        },
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

        const reauthResult = await requireCurrentPasswordReauth(
            userId,
            payload.currentPassword,
            requestMeta.presentedSessionToken,
        )
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
            rateLimited('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        // feat-117 (D4): the answer below says whether the number is taken. Per account as well
        // as per IP and per number, so one account cannot sweep numbers from many addresses.
        const userThrottle = await enforceThrottle(
            throttlePolicies.linkPhoneUser,
            String(userId),
            rateLimited('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(userThrottle)) {
            return Result.err(userThrottle.error)
        }

        const phoneExists = await userRepository.phoneExistsForOtherUser(phone, userId)
        if (phoneExists) {
            return Result.err(conflict('Phone is already linked to another account'))
        }

        const pendingChallengeResult = await findPendingChallenge(phone, LINK_PHONE_FLOW)
        if (Result.isError(pendingChallengeResult)) {
            return Result.err(pendingChallengeResult.error)
        }

        const linkMetadata = {
            userId: String(userId),
            ipAddress: requestMeta.ipAddress,
            provider: authConfig.smsProvider,
            sessionId: requestMeta.sessionId,
        }
        const stillStored = await requireSessionStored(requestMeta.sessionStored)
        if (Result.isError(stillStored)) {
            return Result.err(stillStored.error)
        }
        const issuedChallengeResult = await issueSmsChallenge({
            phone,
            // feat-214: the hourly SMS budget of the number, spent under the lock by the start
            // that opens a challenge. Spent before it, a start the cooldown refused paid too.
            spendBudget: () => spendSmsBudget(phone),
            flow: LINK_PHONE_FLOW,
            metadata: linkMetadata,
            noLongerValid: 'Phone linking challenge is no longer valid',
        })
        if (Result.isError(issuedChallengeResult)) {
            return Result.err(issuedChallengeResult.error)
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
        requestMeta: {
            ipAddress: string
            sessionId: string | null
            presentedSessionToken: string | undefined
            /** feat-123: checked right before the irreversible step. */
            sessionStored: SessionStillStored
        },
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
            rateLimited('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        const challenge = await smsAuthChallengeRepository.findById(payload.challengeId)
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

        const codeResult = await verifySmsCode(challenge, payload.code, {
            noLongerValid: 'Phone linking challenge is no longer valid',
        })
        if (Result.isError(codeResult)) {
            return Result.err(codeResult.error)
        }

        const presentedSessionToken = requestMeta.presentedSessionToken
        const user = await userRepository.findById(userId)
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }
        if (presentedSessionToken === undefined || user.sessionToken !== presentedSessionToken) {
            return Result.err(sessionRevoked())
        }
        if (user.phone !== null && user.phone !== '') {
            return Result.err(badRequest('Phone is already linked to this account'))
        }

        const phoneExists = await userRepository.phoneExistsForOtherUser(challenge.phone, userId)
        if (phoneExists) {
            return Result.err(conflict('Phone is already linked to another account'))
        }

        const stillStored = await requireSessionStored(requestMeta.sessionStored)
        if (Result.isError(stillStored)) {
            return Result.err(stillStored.error)
        }
        const confirmedResult = await confirmChallenge(challenge, {
            noLongerValid: 'Phone linking challenge is no longer valid',
        })
        if (Result.isError(confirmedResult)) {
            return Result.err(confirmedResult.error)
        }

        // feat-096: linked only while the session that asked is still current, in the same
        // statement: a revocation that committed after the check above wins.
        let updatedUser: UserRow | undefined
        try {
            updatedUser = await userRepository.updateIfSessionToken(userId, presentedSessionToken, {
                phone: challenge.phone,
            })
        } catch (err: unknown) {
            // feat-100: another account linked or registered the number after the check above;
            // the unique index answers. The challenge stays confirmed: the user starts again.
            if (isUniqueViolation(err)) {
                return Result.err(conflict('Phone is already linked to another account'))
            }
            throw err
        }
        if (updatedUser === undefined) {
            return Result.err(sessionRevoked())
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
        presentedSessionToken: string | undefined,
        sessionStored: SessionStillStored,
    ): Promise<AppResult<{ status: 'success'; message: string }>> {
        const reauthResult = await requireCurrentPasswordReauth(
            userId,
            payload.currentPassword,
            presentedSessionToken,
        )
        if (Result.isError(reauthResult)) {
            return Result.err(reauthResult.error)
        }

        const user = reauthResult.value
        if (user.email !== null && user.email !== '') {
            return Result.err(badRequest('Email is already linked to this account'))
        }

        const email = normalizeEmail(payload.email)

        const throttled = await enforceEmailLinkThrottles(
            email,
            userId,
            rateLimited('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(throttled)) {
            return Result.err(throttled.error)
        }

        const emailExists = await userRepository.emailExistsForOtherUser(email, userId)
        if (emailExists) {
            return Result.err(conflict('Email is already linked to another account'))
        }

        const stillStored = await requireSessionStored(sessionStored)
        if (Result.isError(stillStored)) {
            return Result.err(stillStored.error)
        }
        const sendResult = await emailVerificationService.sendLinkVerificationEmail(
            userId,
            email,
            presentedSessionToken,
        )
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
        const loginKey = resolveLoginKey(payload.identifier)

        // Consume before the lookup: same cost for every outcome, no check/increment race. A spent
        // counter answers like a wrong password: nothing tells the two apart.
        const ipThrottle = await enforceThrottle(
            throttlePolicies.loginIp,
            requestMeta.ipAddress,
            unauthorized('Invalid email or password'),
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        if (loginKey === null) {
            return invalidCredentials()
        }

        const identifierThrottle = await enforceThrottle(
            throttlePolicies.loginIdentifier,
            loginKey.value,
            unauthorized('Invalid email or password'),
        )
        if (Result.isError(identifierThrottle)) {
            return Result.err(identifierThrottle.error)
        }

        const user = await (loginKey.kind === 'email'
            ? userRepository.findByEmail(loginKey.value)
            : userRepository.findByPhone(loginKey.value))
        // An unknown identifier and an OAuth-only account check the password against a dummy
        // hash: the same scrypt call as a wrong password, so neither the answer nor its time
        // reveals whether the account exists. A pass against the dummy hash never signs in.
        const passwordHash =
            user !== undefined && user.password !== null && user.password !== ''
                ? user.password
                : undefined
        const valid = await validatePassword(
            password,
            passwordHash ?? (await getDummyPasswordHash()),
        )

        if (user === undefined || passwordHash === undefined || !valid) {
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
        await resetThrottleQuietly(throttlePolicies.loginIdentifier, loginKey.value, 'Login')

        const success = await buildAuthSuccess(user, auth, session)
        if (Result.isOk(success)) userNotificationService.security(user.id, 'new_sign_in')
        return success
    },

    async logout(
        auth: Auth,
        session: Session,
    ): Promise<AppResult<{ status: 'success'; csrfToken: string }>> {
        // feat-195: the WebSocket connections opened from this session close with it; the
        // other sessions of the user keep theirs.
        const userId = auth.getUserId()
        const sessionId = session.sessionInfo?.id
        const result = await auth.logout()
        if (userId !== null && sessionId !== undefined) {
            wsSessionRevocation.closeUserConnections(userId, { sessionId })
        }

        if (!result) {
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

        await auth.login(userId, userToken)

        const sessionInfo = session.sessionInfo
        const csrfToken = getSessionCsrfToken(sessionInfo)
        if (sessionInfo === null || csrfToken === undefined) {
            return Result.err(internalMessage('Missing rotated CSRF token'))
        }
        // The open WebSocket is bound to the deleted session: the client reconnects
        // with this token.
        const wsTokenResult = await generateWsToken(sessionInfo, userId)
        return Result.ok({ csrfToken, wsUrl: getWsUrl(), wsToken: wsTokenResult })
    },

    async logoutAll(
        auth: Auth,
        session: Session,
    ): Promise<AppResult<{ status: 'success'; deletedCount: number; csrfToken: string }>> {
        const userId = auth.getUserId()
        // ADR 0002: rotating the sessionToken is the revocation. It comes first and its
        // failure fails the request; auth.logoutAll() below only deletes the records,
        // and every one of them is already rejected if that step fails.
        // feat-096: only while the session that asked is still current; a request let in
        // before a revocation must not rotate the owner's new token away.
        if (userId !== null) {
            const presented = auth.getPresentedUserToken()
            // feat-109: the pending password-reset links are retired with the rotation, in one
            // transaction: "log out everywhere" also ends a reset somebody else asked for.
            const rotated =
                presented === undefined
                    ? undefined
                    : await withTransaction(async (tx) => {
                          const done = await userRepository.updateIfSessionToken(
                              BigInt(userId),
                              presented,
                              { sessionToken: nanoid() },
                              tx,
                          )
                          if (done !== undefined) {
                              await passwordResetRepository.invalidatePendingByUserId(
                                  BigInt(userId),
                                  tx,
                              )
                              // feat-121 (M4): the SMS challenges of the phone too, as an email
                              // reset does: a phone reset started before cannot finish after.
                              if (done.phone !== null && done.phone !== '') {
                                  await invalidatePendingPhoneChallenges(done.phone, tx)
                              }
                          }
                          return done
                      })
            if (rotated === undefined) {
                const current = await userRepository.findSessionToken(BigInt(userId))
                return Result.err(
                    current === undefined ? notFound('User', 'User not found') : sessionRevoked(),
                )
            }
        }
        // feat-195: every session is revoked, so every WebSocket connection of the user closes.
        if (userId !== null) wsSessionRevocation.closeUserConnections(userId)
        // The sessions are revoked by now; what follows is memory cleanup and must not turn
        // the answer into an error. auth.logoutAll() issues the anonymous session either way.
        let deletedCount = 0
        try {
            const cleanup = await auth.logoutAll()
            deletedCount = cleanup.deleted
            if (!cleanup.complete) {
                logger.warn(
                    { userId, deleted: cleanup.deleted },
                    'Logout-all: not every session record was deleted; they are revoked already',
                )
            }
        } catch (err: unknown) {
            // A bug, not an unavailable Redis (that comes as complete: false). Sentry gets it
            // from the logger transport.
            logger.error({ err, userId }, 'Logout-all: deleting the session records failed')
        }
        if (userId !== null) userNotificationService.security(BigInt(userId), 'logout_all')

        const csrfToken = getSessionCsrfToken(session.sessionInfo)
        if (csrfToken === undefined) {
            return Result.err(internalMessage('Missing rotated CSRF token'))
        }

        return Result.ok({
            status: 'success',
            deletedCount,
            csrfToken,
        })
    },

    async changePassword(
        userId: bigint,
        payload: ChangePasswordInput,
        presentedSessionToken: string | undefined,
        /**
         * feat-134 (L1): checked right before the password is written. A logout in another tab
         * deletes this session's record without rotating users.session_token; the change would
         * go through and the controller's renewSession sign the browser in again.
         */
        sessionStored: SessionStillStored,
    ): Promise<AppResult<{ status: 'success'; sessionToken: string }>> {
        // Consumed before the current-password check, same scheme as login.
        const throttle = await enforceThrottle(
            throttlePolicies.changePasswordUser,
            String(userId),
            rateLimited('Too many password change attempts. Please try again later.'),
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }

        const user = await userRepository.findById(userId)
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }
        // feat-096: the row read here may already be the one a claim left (password NULL,
        // token rotated). The session must still be the current one, here and in the update.
        if (presentedSessionToken === undefined || user.sessionToken !== presentedSessionToken) {
            return Result.err(sessionRevoked())
        }

        const storedPassword = user.password
        const hasPassword = storedPassword !== null && storedPassword !== ''
        if (hasPassword) {
            if (payload.currentPassword === undefined || payload.currentPassword === '') {
                return Result.err(badRequest('Current password is required'))
            }

            const currentPassword = payload.currentPassword
            const valid = await validatePassword(currentPassword, storedPassword)

            if (!valid) {
                return Result.err(badRequest('Current password is incorrect'))
            }
        }

        const newPasswordHash = await hashPassword(payload.newPassword)

        const stillStored = await requireSessionStored(sessionStored)
        if (Result.isError(stillStored)) {
            return Result.err(stillStored.error)
        }

        // ADR 0002: the new password and the rotated sessionToken are one conditional
        // UPDATE. Every other session of the user stops working with it, whether or not
        // the Redis cleanup below finishes; of two concurrent changes made against the
        // same current password only one finds it still in place; and a change let in
        // before a revocation finds the presented sessionToken gone (feat-096).
        const previousSessionToken = user.sessionToken
        const rotatedSessionToken = nanoid()
        // feat-109: the pending password-reset links go in the same transaction: a link asked
        // for before the change cannot reset the password after it, and a failure retiring
        // them rolls the change back.
        const updated = await withTransaction(async (tx) => {
            const changed = await userRepository.changePasswordIfCurrent(
                userId,
                storedPassword,
                presentedSessionToken,
                { password: newPasswordHash, sessionToken: rotatedSessionToken },
                tx,
            )
            if (changed !== undefined) {
                await passwordResetRepository.invalidatePendingByUserId(userId, tx)
                // feat-121 (M4): and the pending SMS challenges of the phone, as an email reset
                // does: a phone reset started before the change cannot set the password after it.
                if (changed.phone !== null && changed.phone !== '') {
                    await invalidatePendingPhoneChallenges(changed.phone, tx)
                }
            }
            return changed
        })

        if (updated === undefined) {
            // Which condition lost: another change of the password (its own token rotation
            // comes with it) is the old conflict; a token rotated without one (a claim,
            // logout everywhere) means this session was revoked meanwhile.
            const current = await userRepository.findById(userId)
            if (current === undefined) {
                return Result.err(notFound('User', 'User not found'))
            }
            if (current.password !== storedPassword) {
                return Result.err(
                    conflict('Password was changed by another request. Please try again.'),
                )
            }
            return Result.err(sessionRevoked())
        }

        await resetThrottleQuietly(
            throttlePolicies.changePasswordUser,
            String(userId),
            'Change password',
        )

        // feat-195: the connections of every session close, this one's too: its socket carries
        // the token that was just rotated, and the client reconnects with the WS token of the
        // renewed session.
        wsSessionRevocation.closeUserConnections(String(userId))

        // Memory cleanup, not the revocation: a failure leaves records that are already
        // rejected, so it is logged and the password change still succeeds.
        try {
            const cleanup = await destroyAllSessions(previousSessionToken)
            if (!cleanup.complete) {
                logger.warn(
                    { userId: String(userId), deleted: cleanup.deleted },
                    'Not every previous session deleted after a password change',
                )
            }
        } catch (err: unknown) {
            logger.warn(
                { err, userId: String(userId) },
                'Previous sessions not deleted after a password change',
            )
        }

        userNotificationService.security(userId, 'password_changed')
        return Result.ok({ status: 'success', sessionToken: rotatedSessionToken })
    },
}
