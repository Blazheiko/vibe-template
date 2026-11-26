import { hashPassword, validatePassword } from 'metautil'
import { toIsoDateTime, type IsoDateTime } from 'shared/brand'
import type { NormalizedEmail } from '#app/domain/email.js'
import { presentedSessionTokenOf, type SessionToken, newSessionToken } from '#app/domain/secrets.js'
import { Result } from 'better-result'
import type { Auth, LoginOrigin, Session } from '#vendor/types/types.js'
import { notifyNewSignIn } from '#app/services/auth/new-sign-in-notice.js'
import {
    smsAuthChallengeRepository,
    userRepository,
    withTransaction,
} from '#app/repositories/index.js'
import { withTransactionResult } from '#app/services/shared/transaction-result.js'
import { withProof, withRole, type UserAuditActor } from '#app/services/audit/audit-actor.js'
import { auditService, type RecordedAuditEvent } from '#app/services/audit/audit-service.js'
import type { UserRow } from '#app/repositories/index.js'
import { userTransformer } from '#app/transformers/index.js'
import {
    badRequest,
    conflict,
    internalMessage,
    logoutRetry,
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
import type { AcceptedProof, SessionAuthState } from 'shared/mfa'
import { loadMfaAccount } from '#app/services/auth/mfa/mfa-account.js'
import { requireProof } from '#app/services/auth/mfa/require-proof.js'
import logger from '#vendor/utils/logger.js'
import { maskPhoneForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { authConfig } from '#config/auth.js'
import { consumeAuthThrottle, resetAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import { enforceEmailLinkThrottles, enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { retirePendingResets } from '#app/services/auth/phone-challenges.js'
import {
    findSmsChallenge,
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
import { SessionDeletionDeferredError } from '#vendor/utils/session/session-deletion-lock.js'
import { destroyAllSessions } from '#vendor/utils/session/redis-session-storage.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'
import { wsSessionRevocation } from '#app/services/auth/ws-session-revocation.js'
import { pushSubscriptionService } from '#app/services/notifications/push-subscription-service.js'
import { authSuccessPayload, type AuthSuccessPayload } from '#app/services/auth/auth-success.js'
import {
    startSecondStepIfRequired,
    type SecondStepRequired,
} from '#app/services/auth/mfa/mfa-sign-in.js'
import { toEntityId, asUserId, type UserId, type SmsChallengeId } from '#app/domain/ids.js'

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

type LoginKey = { kind: 'email'; value: NormalizedEmail } | { kind: 'phone'; value: string }

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

/**
 * feat-245 (rows 6–7 of Р3): the user of a sensitive action of their own account, once the session
 * still is the current one and the proof matrix lets it through (a fresh password without MFA, a
 * fresh second factor with it, a recent OAuth sign-in of an account without a password), with the
 * proof that let it through (Р14).
 */
async function requireStepUp(
    userId: UserId,
    presentedSessionToken: SessionToken | undefined,
    sessionAuth: SessionAuthState | undefined,
    action: 'password.change' | 'contact.link',
): Promise<AppResult<{ user: UserRow; proof: AcceptedProof }>> {
    const user = await userRepository.findById(userId)
    if (user === undefined) {
        return Result.err(notFound('User', 'User not found'))
    }
    if (presentedSessionToken === undefined || user.sessionToken !== presentedSessionToken) {
        return Result.err(sessionRevoked())
    }
    const proof = requireProof({ action, account: await loadMfaAccount(user), auth: sessionAuth })
    if (Result.isError(proof)) return Result.err(proof.error)
    return Result.ok({ user, proof: proof.value })
}

async function buildAuthSuccess(
    user: Awaited<ReturnType<typeof userRepository.create>>,
    auth: Auth,
    session: Session,
    origin: LoginOrigin,
    loginFailureMessage = 'Failed to log in user',
): Promise<AppResult<AuthSuccessPayload>> {
    const loggedInResult = await auth.login(toEntityId(user.id), user.sessionToken, origin)

    if (loggedInResult === null) {
        return Result.err(internalMessage(loginFailureMessage))
    }

    return Result.ok(await authSuccessPayload(user, session))
}

async function persistRegisteredUser(
    createUserInput: {
        name: string
        email: NormalizedEmail | null
        phone: string | null
        passwordHash: string
    },
    options: {
        sendEmailVerification: boolean
        challengeIdToInvalidate?: SmsChallengeId
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
        email: NormalizedEmail | null
        phone: string | null
        passwordHash: string
    },
    auth: Auth,
    session: Session,
    options: {
        sendEmailVerification: boolean
        challengeIdToInvalidate?: SmsChallengeId
        loginFailureMessage?: string
    },
): Promise<AppResult<AuthSuccessPayload>> {
    const persistOptions: {
        sendEmailVerification: boolean
        challengeIdToInvalidate?: SmsChallengeId
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
        { method: 'register' },
        options.loginFailureMessage ?? 'Failed to log in user',
    )
}

/**
 * Sends the verification mail again, in the background and at most once per interval per
 * account. Nothing here may change the answer of the login or delay it, and a failure (Redis
 * down, no mail transport) is only logged.
 */
async function resendVerificationAfterUnverifiedLogin(userId: UserId): Promise<void> {
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

/**
 * feat-254: the push record of the browser that signed out, removed once its session is gone, so
 * the account's notifications stop arriving there. After the deletion, not before it: a logout the
 * row lock defers (`logout_retry`, Р13) keeps the session, and a record removed ahead of it would
 * leave a signed-in browser without push and the client to put the record back, which raced with
 * the next sign-out. Not inside the lock either: the lock guards the session record only, and
 * push work there would hold the user's row lock longer and tie the logout to the push table.
 * Best effort: a failure is logged and the logout still answers success (the session is gone).
 */
async function releasePushRecord(userId: UserId, pushEndpoint: string): Promise<void> {
    try {
        await pushSubscriptionService.deleteOwnSubscriptionByEndpoint(userId, pushEndpoint)
    } catch (err) {
        logger.warn({ err, userId: String(userId) }, 'Logout: removing the push record failed')
    }
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
            expiresAt: IsoDateTime
            resendAvailableAt: IsoDateTime
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
            expiresAt: toIsoDateTime(issuedChallengeResult.value.expiresAt),
            resendAvailableAt: toIsoDateTime(issuedChallengeResult.value.resendAvailableAt),
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
        const challenge = await findSmsChallenge(payload.challengeId)
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

        const challenge = await findSmsChallenge(payload.challengeId)
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
        userId: UserId,
        payload: LinkPhoneStartInput,
        requestMeta: {
            ipAddress: string
            sessionId: string | null
            presentedSessionToken: SessionToken | undefined
            /** feat-123: checked right before the irreversible step. */
            sessionStored: SessionStillStored
            /** feat-245 (row 7 of Р3): how the session was authenticated. */
            sessionAuth: SessionAuthState | undefined
        },
    ): Promise<
        AppResult<{
            status: 'success'
            challengeId: string
            expiresAt: IsoDateTime
            resendAvailableAt: IsoDateTime
        }>
    > {
        const gateResult = assertPhoneAuthEnabled()
        if (gateResult !== undefined) {
            return gateResult
        }

        if (requestMeta.sessionId === null) {
            return Result.err(badRequest('Phone linking requires an active session'))
        }

        const reauthResult = await requireStepUp(
            userId,
            requestMeta.presentedSessionToken,
            requestMeta.sessionAuth,
            'contact.link',
        )
        if (Result.isError(reauthResult)) {
            return Result.err(reauthResult.error)
        }

        const { user } = reauthResult.value
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
            expiresAt: toIsoDateTime(issuedChallengeResult.value.expiresAt),
            resendAvailableAt: toIsoDateTime(issuedChallengeResult.value.resendAvailableAt),
        })
    },

    async confirmPhoneLink(
        userId: UserId,
        payload: LinkPhoneConfirmInput,
        requestMeta: {
            ipAddress: string
            sessionId: string | null
            presentedSessionToken: SessionToken | undefined
            /** feat-123: checked right before the irreversible step. */
            sessionStored: SessionStillStored
        },
        /** feat-235: who links it: the signed-in user of the request. */
        actor: UserAuditActor,
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

        const challenge = await findSmsChallenge(payload.challengeId)
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

        // feat-235 (Р3): the code is confirmed in the transaction that links the number and
        // records the event, so a failure of either leaves the code unconfirmed and usable again.
        // withTransactionResult, not withTransaction: a refusal after the confirmation must roll
        // it back too. The row is locked first and checked again under the lock: two requests of
        // one account with two numbers both passed the checks above, and the second used to
        // overwrite the number of the first.
        let linked: AppResult<{ user: UserRow; events: RecordedAuditEvent[] }>
        try {
            linked = await withTransactionResult(async (tx) => {
                const locked = await userRepository.lockById(userId, tx)
                if (locked === undefined) {
                    return Result.err(notFound('User', 'User not found'))
                }
                // feat-096: a revocation that committed after the check above wins.
                if (locked.sessionToken !== presentedSessionToken) {
                    return Result.err(sessionRevoked())
                }
                if (locked.phone !== null && locked.phone !== '') {
                    return Result.err(badRequest('Phone is already linked to this account'))
                }
                const confirmedResult = await confirmChallenge(
                    challenge,
                    { noLongerValid: 'Phone linking challenge is no longer valid' },
                    tx,
                )
                if (Result.isError(confirmedResult)) {
                    return Result.err(confirmedResult.error)
                }
                const updated = await userRepository.update(userId, { phone: challenge.phone }, tx)
                if (updated === undefined) {
                    return Result.err(notFound('User', 'User not found'))
                }
                const stamp = await auditService.stamp(tx)
                const events = await auditService.record(
                    tx,
                    stamp,
                    withProof(withRole(actor, locked.role), 'sms_code'),
                    [
                        {
                            action: 'auth.phone.linked',
                            targetId: String(userId),
                            targetUserId: userId,
                            input: {},
                        },
                    ],
                )
                return Result.ok({ user: updated, events })
            })
        } catch (err: unknown) {
            // feat-100: another account linked or registered the number after the check above;
            // the unique index answers. The transaction rolled back with it, so the challenge is
            // not confirmed; the same code meets the check above again.
            if (isUniqueViolation(err)) {
                return Result.err(conflict('Phone is already linked to another account'))
            }
            throw err
        }
        if (Result.isError(linked)) {
            return Result.err(linked.error)
        }
        auditService.logCommitted(actor.logger, linked.value.events)

        return Result.ok({
            status: 'success',
            message: 'Phone linked successfully',
            user: userTransformer.serialize(linked.value.user),
        })
    },

    async startEmailLink(
        userId: UserId,
        payload: LinkEmailStartInput,
        presentedSessionToken: SessionToken | undefined,
        sessionStored: SessionStillStored,
        /** feat-245 (row 7 of Р3): how the session was authenticated. */
        sessionAuth: SessionAuthState | undefined,
    ): Promise<AppResult<{ status: 'success'; message: string }>> {
        const reauthResult = await requireStepUp(
            userId,
            presentedSessionToken,
            sessionAuth,
            'contact.link',
        )
        if (Result.isError(reauthResult)) {
            return Result.err(reauthResult.error)
        }

        const { user } = reauthResult.value
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
    ): Promise<AppResult<AuthSuccessPayload | SecondStepRequired>> {
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

        // feat-245 (Р4): an account with a second factor gets a ticket, not a session.
        const second = await startSecondStepIfRequired(auth, user, { method: 'password' })
        if (Result.isError(second)) return Result.err(second.error)
        if (second.value !== null) {
            const csrfToken = getSessionCsrfToken(session.sessionInfo)
            return Result.ok({
                ...second.value,
                ...(csrfToken !== undefined ? { csrfToken } : {}),
            })
        }

        const success = await buildAuthSuccess(user, auth, session, { method: 'password' })
        const device = session.sessionInfo?.data.device
        if (Result.isOk(success) && device !== undefined) {
            notifyNewSignIn(user.id, device, { mail: true })
        }
        return success
    },

    /**
     * `pushEndpoint` (feat-254): this browser's push subscription; its record of the user goes
     * with the session (releasePushRecord).
     */
    async logout(
        auth: Auth,
        session: Session,
        options: { pushEndpoint?: string | undefined } = {},
    ): Promise<AppResult<{ status: 'success'; csrfToken: string }>> {
        // feat-195: the WebSocket connections opened from this session close with it; the
        // other sessions of the user keep theirs.
        const userId = auth.getUserId()
        const sessionId = session.sessionInfo?.id
        // Read before the logout replaces the session with an anonymous one.
        const signedInUserId =
            userId !== null && typeof session.sessionInfo?.data.userToken === 'string'
                ? userId
                : null
        let result: boolean
        try {
            result = await auth.logout()
        } catch (err) {
            // Р13: the record was not deleted under the row lock; the session (and its sockets)
            // stays signed in and the browser sends the logout again.
            if (err instanceof SessionDeletionDeferredError) return Result.err(logoutRetry())
            throw err
        }
        if (userId !== null && sessionId !== undefined) {
            wsSessionRevocation.closeUserConnections(userId, { sessionId })
        }

        if (!result) {
            return Result.err(internalMessage('Failed to log out user'))
        }
        if (signedInUserId !== null && options.pushEndpoint !== undefined) {
            await releasePushRecord(asUserId(signedInUserId), options.pushEndpoint)
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

        // feat-233 (Р3): the renewed session keeps how and where the user signed in. Its record is
        // gone by now, but the request still holds what it read.
        const device = session.sessionInfo?.data.device
        // feat-245 (Р2): and how it was authenticated, so a renewal never lowers the level.
        const previousAuth = session.sessionInfo?.data.auth
        await auth.login(
            userId,
            userToken,
            device !== undefined ? { inherit: device } : { method: 'password' },
            previousAuth,
        )

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
        /** feat-235: who ends the sessions: the signed-in user of the request. */
        actor: UserAuditActor,
    ): Promise<AppResult<{ status: 'success'; deletedCount: number; csrfToken: string }>> {
        const userId = auth.getUserId()
        // ADR 0002: rotating the sessionToken is the revocation. It comes first and its
        // failure fails the request; auth.logoutAll() below only deletes the records,
        // and every one of them is already rejected if that step fails.
        // feat-096: only while the session that asked is still current; a request let in
        // before a revocation must not rotate the owner's new token away.
        if (userId !== null) {
            const presented = presentedSessionTokenOf(auth.getPresentedUserToken())
            // feat-109: the pending password-reset links are retired with the rotation, in one
            // transaction: "log out everywhere" also ends a reset somebody else asked for.
            const rotated =
                presented === undefined
                    ? undefined
                    : await withTransaction(async (tx) => {
                          const done = await userRepository.updateIfSessionToken(
                              asUserId(userId),
                              presented,
                              { sessionToken: newSessionToken() },
                              tx,
                          )
                          if (done === undefined) return undefined
                          // feat-121 (M4): the SMS challenges of the phone too, as an email
                          // reset does: a phone reset started before cannot finish after.
                          await retirePendingResets(done, tx)
                          // feat-235: the event commits with the rotation; a failed insert
                          // leaves the previous token valid.
                          const stamp = await auditService.stamp(tx)
                          const events = await auditService.record(
                              tx,
                              stamp,
                              withRole(actor, done.role),
                              [
                                  {
                                      action: 'auth.sessions.revoked_all',
                                      targetId: String(done.id),
                                      targetUserId: done.id,
                                      input: {},
                                  },
                              ],
                          )
                          return { done, events }
                      })
            if (rotated === undefined) {
                const current = await userRepository.findSessionToken(asUserId(userId))
                return Result.err(
                    current === undefined ? notFound('User', 'User not found') : sessionRevoked(),
                )
            }
            auditService.logCommitted(actor.logger, rotated.events)
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
        if (userId !== null) userNotificationService.security(asUserId(userId), 'logout_all')

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
        userId: UserId,
        payload: ChangePasswordInput,
        presentedSessionToken: SessionToken | undefined,
        /**
         * feat-134 (L1): checked right before the password is written. A logout in another tab
         * deletes this session's record without rotating users.session_token; the change would
         * go through and the controller's renewSession sign the browser in again.
         */
        sessionStored: SessionStillStored,
        /**
         * feat-221: the session that asks. Its connections are not closed here: the controller
         * renews it first, and its client then replaces the socket itself.
         */
        requestingSessionId: string | undefined,
        /** feat-235: who changes it: the signed-in user of the request. */
        actor: UserAuditActor,
        /** feat-245 (row 6 of Р3): how the session was authenticated. */
        sessionAuth: SessionAuthState | undefined,
    ): Promise<AppResult<{ status: 'success'; sessionToken: string }>> {
        // feat-096: the row read here may already be the one a claim left (password NULL,
        // token rotated). The session must still be the current one, here and in the update.
        // feat-245: the change is allowed by the proof matrix, not by a password in the form.
        const stepUp = await requireStepUp(
            userId,
            presentedSessionToken,
            sessionAuth,
            'password.change',
        )
        if (Result.isError(stepUp)) return Result.err(stepUp.error)
        const { user, proof } = stepUp.value
        if (presentedSessionToken === undefined) return Result.err(sessionRevoked())
        // ADR 0002: the stored hash read here (null for an account without one) is what the
        // conditional update below compares; a concurrent change makes it miss.
        const storedPassword = user.password

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
        const rotatedSessionToken = newSessionToken()
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
            if (changed === undefined) return undefined
            // feat-121 (M4): and the pending SMS challenges of the phone, as an email reset does:
            // a phone reset started before the change cannot set the password after it.
            await retirePendingResets(changed, tx)
            // feat-235: the event commits with the change; a failed insert keeps the old
            // password and token.
            const stamp = await auditService.stamp(tx)
            const proven = withProof(actor, proof)
            const events = await auditService.record(tx, stamp, withRole(proven, changed.role), [
                {
                    action: 'auth.password.changed',
                    targetId: String(userId),
                    targetUserId: userId,
                    input: {},
                },
            ])
            return { changed, events }
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

        auditService.logCommitted(actor.logger, updated.events)

        await resetThrottleQuietly(
            throttlePolicies.changePasswordUser,
            String(userId),
            'Change password',
        )

        // feat-195: the connections of every other session close at once. feat-221: not those of
        // the session that asked. A 4001 here reached the client before the HTTP answer; it
        // asked for a new WS token with the old cookie, got 401 and signed out, although its
        // session was renewed. The controller closes them when the renewal fails; after a
        // renewal the client replaces the socket with the new WS token, and the re-check closes
        // whatever is left (its token is rotated), as it does for another instance.
        wsSessionRevocation.closeUserConnections(
            String(userId),
            requestingSessionId === undefined ? {} : { exceptSessionId: requestingSessionId },
        )

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
