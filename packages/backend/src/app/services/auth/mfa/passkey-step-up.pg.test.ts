import { randomBytes } from 'node:crypto'
import type { SessionToken } from '#app/domain/secrets.js'
import type { UserId } from '#app/domain/ids.js'

import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import { SoftAuthenticator } from '../../../../test-support/soft-authenticator.js'
import type { Session, SessionData, SessionInfo } from '#vendor/types/types.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р3, Р5, Р6; tasks P4) against a real PostgreSQL and
// real WebAuthn answers: a passkey step-up records `verified.webauthn`, spends the challenge of
// this session once, refuses another user's key and a recovery session.

const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))

describe.skipIf(!hasPg)('passkey step-up on PostgreSQL (feat-246 P4)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users } = await import('#database/schema.js')
    const { default: webauthnConfig } = await import('#config/webauthn.js')
    const { webauthnCredentialRepository, withTransaction } =
        await import('#app/repositories/index.js')
    const { stepUpService, PASSKEY_REAUTH_KEYS } = await import('./step-up.js')
    const { registrationOptions, verifyWebAuthnCeremony, ceremonyBinding } =
        await import('./webauthn-ceremony.js')
    const { mergeSessionAuth, sessionAuthOf } = await import('shared/mfa')

    const RP = webauthnConfig.rpId
    const ORIGIN = webauthnConfig.origins[0] ?? ''
    const created: UserId[] = []
    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })

    const userWithPasskey = async (name: string) => {
        const [row] = await db
            .insert(users)
            .values({ name, email: `${name}-${crypto.randomUUID()}@example.test` })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        created.push(row.id)
        const authenticator = new SoftAuthenticator({ counter: 1 })
        const handle = await withTransaction((tx) =>
            webauthnCredentialRepository.ensureUserHandle(row.id, randomBytes(32), tx),
        )
        const options = await registrationOptions({
            userHandle: handle,
            userName: name,
            displayName: name,
            exclude: [],
        })
        const binding = ceremonyBinding('register', 'x')
        const verified = await verifyWebAuthnCeremony({
            purpose: 'register',
            stored: { challenge: options.challenge, binding },
            expectedBinding: binding,
            response: authenticator.register({
                challenge: options.challenge,
                rpId: RP,
                origin: ORIGIN,
                userHandle: options.user.id,
            }),
        })
        if (!verified.ok || !('registration' in verified)) throw new Error('not registered')
        await withTransaction((tx) =>
            webauthnCredentialRepository.insert(
                {
                    userId: row.id,
                    ...verified.registration,
                    name: 'Key',
                    enrollmentId: crypto.randomUUID().replaceAll('-', ''),
                },
                tx,
            ),
        )
        return { row, authenticator }
    }

    /** An in-memory session: data writes, an atomic consume and the auth merge of the store. */
    const fakeSession = (data: SessionData): Session => {
        const session = {
            sessionInfo: { id: `s-${crypto.randomUUID()}`, data, createdAt: '' } as SessionInfo,
            updateSessionData: (newData: SessionData) => {
                session.sessionInfo = {
                    ...session.sessionInfo,
                    data: { ...session.sessionInfo.data, ...newData },
                }
                return Promise.resolve(session.sessionInfo)
            },
            changeSessionData: () => Promise.resolve(null),
            consumeSessionData: (expected: Record<string, string>, keys: readonly string[]) => {
                const stored = session.sessionInfo.data
                if (Object.keys(expected).some((key) => stored[key] === undefined)) {
                    return Promise.resolve('gone' as const)
                }
                if (Object.entries(expected).some(([key, value]) => stored[key] !== value)) {
                    return Promise.resolve('mismatch' as const)
                }
                session.sessionInfo = {
                    ...session.sessionInfo,
                    data: Object.fromEntries(
                        Object.entries(stored).filter(([key]) => !keys.includes(key)),
                    ),
                }
                return Promise.resolve('consumed' as const)
            },
            isStored: () => Promise.resolve(true),
            destroySession: () => Promise.resolve(),
            updateSessionAuth: (apply: Parameters<Session['updateSessionAuth']>[0]) => {
                const current = sessionAuthOf(session.sessionInfo.data.auth)
                session.sessionInfo = {
                    ...session.sessionInfo,
                    data: {
                        ...session.sessionInfo.data,
                        auth: mergeSessionAuth(current, apply(current)),
                    },
                }
                return Promise.resolve(session.sessionInfo)
            },
        }
        return session
    }

    const signedIn = (): SessionData => ({
        auth: {
            v: 1,
            amr: ['webauthn'],
            aal: 2,
            authenticatedAt: new Date(Date.now() - 3_600_000).toISOString(),
            verified: {},
        },
    })

    const request = (row: { id: UserId; sessionToken: SessionToken }, session: Session) => ({
        userId: row.id,
        session,
        presentedSessionToken: row.sessionToken,
    })

    const optionsFor = async (
        row: { id: UserId; sessionToken: SessionToken },
        session: Session,
    ) => {
        const options = await stepUpService.passkeyOptions(request(row, session))
        if (options.status !== 'ok') throw new Error('no options')
        return (options.value.options as { challenge: string }).challenge
    }

    it('a passkey step-up records verified.webauthn and spends the challenge', async () => {
        const { row, authenticator } = await userWithPasskey('stepup-ok')
        const session = fakeSession(signedIn())
        expect((await stepUpService.options(request(row, session))).status).toBe('ok')
        const challenge = await optionsFor(row, session)
        const response = authenticator.authenticate({ challenge, rpId: RP, origin: ORIGIN })
        const result = await stepUpService.reauth(request(row, session), {
            proof: 'webauthn',
            response,
        })
        expect(result.status).toBe('ok')
        expect(session.sessionInfo?.data.auth?.verified.webauthn).toBeDefined()
        expect(session.sessionInfo?.data[PASSKEY_REAUTH_KEYS.challenge]).toBeUndefined()

        // The same answer again: the challenge is gone.
        const again = await stepUpService.reauth(request(row, session), {
            proof: 'webauthn',
            response,
        })
        expect(again.status === 'error' && again.error).toMatchObject({ reason: 'invalid_code' })
    })

    it("another user's key is refused and leaves no mark", async () => {
        const { row } = await userWithPasskey('stepup-mine')
        const other = await userWithPasskey('stepup-theirs')
        const session = fakeSession(signedIn())
        const challenge = await optionsFor(row, session)
        const response = other.authenticator.authenticate({ challenge, rpId: RP, origin: ORIGIN })
        const result = await stepUpService.reauth(request(row, session), {
            proof: 'webauthn',
            response,
        })
        expect(result.status === 'error' && result.error).toMatchObject({ reason: 'invalid_code' })
        expect(session.sessionInfo?.data.auth?.verified.webauthn).toBeUndefined()
    })

    it('a challenge of another session does not pass here (binding reauth:<sessionId>)', async () => {
        const { row, authenticator } = await userWithPasskey('stepup-binding')
        const first = fakeSession(signedIn())
        const challenge = await optionsFor(row, first)
        const second = fakeSession(signedIn())
        await optionsFor(row, second)
        const response = authenticator.authenticate({ challenge, rpId: RP, origin: ORIGIN })
        const result = await stepUpService.reauth(request(row, second), {
            proof: 'webauthn',
            response,
        })
        expect(result.status).toBe('error')
    })

    it('a recovery session gives no step-up', async () => {
        const { row } = await userWithPasskey('stepup-recovery')
        const session = fakeSession({
            auth: {
                v: 1,
                amr: ['pwd', 'recovery'],
                aal: 1,
                authenticatedAt: new Date().toISOString(),
                verified: {},
                recovery: {
                    startedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 600_000).toISOString(),
                },
            },
        })
        const options = await stepUpService.passkeyOptions(request(row, session))
        expect(options.status === 'error' && options.error).toMatchObject({
            reason: 'recovery_session',
        })
    })
})
