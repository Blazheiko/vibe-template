import { createServer } from 'node:net'

import { and, eq, isNull } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import type * as SessionIndex from '#vendor/utils/session/session-index.js'
import type * as SessionStorage from '#vendor/utils/session/redis-session-storage.js'
import type * as Transaction from '#app/repositories/transaction.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../../test-support/redis-test-client.js'
import { SoftAuthenticator } from '../../../../test-support/soft-authenticator.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4, tasks M8) over HTTP: a real uWebSockets.js server
// with the real routes and session layer, a real PostgreSQL and Redis. The password sign-in of an
// account with TOTP opens a ticket; POST /auth/mfa/verify finishes it once, and a repeat finishes
// what an earlier request confirmed. Failures are injected where the plan names them: Redis during
// the preparation and the activation, the answer of COMMIT, a rollback after the work. The pool
// reaches PostgreSQL through a TCP proxy (test-support/pg-commit-drop-proxy.ts) that can also
// drop the connection for real while COMMIT is answered.

const getFreePort = () =>
    new Promise<number>((resolve, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address()
            probe.close(() => {
                resolve(typeof address === 'object' && address !== null ? address.port : 0)
            })
        })
    })

// Before #database/db.js is imported: the pools connect to the throwaway database of
// pg-global-setup.ts through the proxy.
const proxy = await vi.hoisted(async () => {
    const { CommitDropProxy } = await import('../../../../test-support/pg-commit-drop-proxy.js')
    const commitDrop = new CommitDropProxy({
        host: process.env['PGSQL_HOST'] ?? '127.0.0.1',
        port: Number(process.env['PGSQL_PORT'] ?? 5432),
    })
    process.env['PGSQL_HOST'] = '127.0.0.1'
    process.env['PGSQL_PORT'] = String(await commitDrop.start())
    return commitDrop
})

const PORT = await getFreePort()
const ORIGIN = `http://localhost:${String(PORT)}`

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['CSRF_ENFORCE'] = 'true'
    process.env['CSRF_STRICT_ORIGIN'] = 'true'
    process.env['MFA_ENCRYPTION_KEYS'] = `k1:${Buffer.alloc(32, 5).toString('base64')}`
    process.env['AUTH_OTP_HMAC_KEY'] ??= 'o'.repeat(32)
    return { PREFIX: `test:${crypto.randomUUID()}:` }
})
process.env['CSRF_ALLOWED_ORIGINS'] = ORIGIN

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
vi.mock('#config/app.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return {
        default: {
            ...actual.default,
            host: '127.0.0.1',
            port: PORT,
            serveStatic: false,
            unixPath: undefined,
            pathPrefix: 'api',
        },
    }
})
vi.mock('#config/redis.js', async (importActual) => {
    const actual = await importActual<{ default: object }>()
    return { default: { ...actual.default, keyPrefix: PREFIX } }
})
vi.mock('#database/redis.js', async () => {
    const { Redis: Client } = await import('ioredis')
    const { mainRedisOptions } = await import('#database/redis-main-options.js')
    const { createRedisHealth, createWithRedis } = await import('#database/redis-health.js')
    const { host: _host, port: _port, ...contract } = mainRedisOptions
    const client = new Client(process.env['REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379', {
        ...contract,
        keyPrefix: PREFIX,
        lazyConnect: true,
    })
    const redisHealth = createRedisHealth(client, {
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    })
    return { default: client, redisHealth, withRedis: createWithRedis(client, redisHealth) }
})
vi.mock('#vendor/utils/rate-limit/http-rate-limit.js', () => ({
    default: () => true,
    checkGlobalRateLimit: () => true,
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
const security = vi.hoisted(() => vi.fn())
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security, supportReply: vi.fn() },
}))
const newSignIn = vi.hoisted(() => vi.fn())
vi.mock('#app/services/auth/new-sign-in-notice.js', async (importActual) => {
    const actual = await importActual<Record<string, unknown>>()
    return { ...actual, notifyNewSignIn: newSignIn }
})

// Injected failures (Р4, «Збої»).
interface Injected {
    prepare: boolean
    /** Runs this, then fails the activation as an unreachable Redis would. */
    activate: false | (() => Promise<void>)
    lostCommitAnswer: boolean
    rollbackAfterWork: boolean
    /** The clock jumps this far ahead inside the transaction (after the reservation). */
    clockJumpMs: number
    /** pg_xact_status reads that fail (the outcome stays undetermined). */
    statusUnknown: number
    /** pg_xact_status reads made (counted, not injected). */
    statusReads: number
    /** The claim of the activation's effects fails (Redis), once. */
    claim: boolean
    /** The recovery cleanup of the rotated token stops part-way (Redis), once. */
    cleanup: boolean
}
const inject = vi.hoisted((): Injected => ({
    prepare: false,
    activate: false,
    lostCommitAnswer: false,
    rollbackAfterWork: false,
    clockJumpMs: 0,
    statusUnknown: 0,
    statusReads: 0,
    claim: false,
    cleanup: false,
}))
vi.mock('#vendor/utils/session/session-index.js', async (importActual) => {
    const actual = await importActual<typeof SessionIndex>()
    return {
        ...actual,
        preparePendingSession: (...args: Parameters<typeof actual.preparePendingSession>) => {
            if (inject.prepare) {
                inject.prepare = false
                return Promise.reject(new Error('Redis down (prepare)'))
            }
            return actual.preparePendingSession(...args)
        },
        activatePendingSession: async (
            ...args: Parameters<typeof actual.activatePendingSession>
        ) => {
            if (inject.activate !== false) {
                const before = inject.activate
                inject.activate = false
                await before()
                throw new Error('Redis down (activate)')
            }
            return actual.activatePendingSession(...args)
        },
        claimActivationEffects: (...args: Parameters<typeof actual.claimActivationEffects>) => {
            if (inject.claim) {
                inject.claim = false
                return Promise.reject(new Error('Redis down (claim)'))
            }
            return actual.claimActivationEffects(...args)
        },
    }
})
vi.mock('#vendor/utils/session/redis-session-storage.js', async (importActual) => {
    const actual = await importActual<typeof SessionStorage>()
    return {
        ...actual,
        destroyAllSessions: (...args: Parameters<typeof actual.destroyAllSessions>) => {
            if (inject.cleanup) {
                inject.cleanup = false
                return Promise.resolve({ deleted: 0, complete: false })
            }
            return actual.destroyAllSessions(...args)
        },
    }
})
vi.mock('#app/repositories/transaction.js', async (importActual) => {
    const actual = await importActual<typeof Transaction>()
    return {
        ...actual,
        transactionStatus: (...args: Parameters<typeof actual.transactionStatus>) => {
            inject.statusReads += 1
            if (inject.statusUnknown > 0) {
                inject.statusUnknown -= 1
                return Promise.reject(new Error('PostgreSQL unreachable (status)'))
            }
            return actual.transactionStatus(...args)
        },
        withTransaction: async <T>(work: (tx: Transaction.DbTransaction) => Promise<T>) => {
            if (inject.clockJumpMs > 0) {
                // The factor check or the row lock outlasts the reservation: the server's clock
                // is ahead while the transaction runs.
                const jump = inject.clockJumpMs
                inject.clockJumpMs = 0
                const realNow = Date.now.bind(Date)
                const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + jump)
                try {
                    return await actual.withTransaction(work)
                } finally {
                    clock.mockRestore()
                }
            }
            if (inject.rollbackAfterWork) {
                inject.rollbackAfterWork = false
                // The work ran and then the transaction rolled back (the COMMIT failed in a way
                // the caller cannot tell from a lost answer).
                return actual.withTransaction(async (tx) => {
                    await work(tx)
                    throw new Error('connection lost (rolled back)')
                })
            }
            const result = await actual.withTransaction(work)
            if (inject.lostCommitAnswer) {
                inject.lostCommitAnswer = false
                throw new Error('connection lost (committed)')
            }
            return result
        },
    }
})

describe.skipIf(!hasPg || !hasRedis)('second sign-in step over HTTP (feat-245 M8)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, mfaRecoveryCodes } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { hashPassword } = await import('metautil')
    const { default: sessionConfig } = await import('#config/session.js')
    const { mfaTicketCookieName } = await import('#vendor/utils/session/request-session.js')
    const { getSession } = await import('#vendor/utils/session/redis-session-storage.js')
    const { totpFactorRepository, withTransaction } = await import('#app/repositories/index.js')
    const { recoveryCodes } = await import('./recovery-codes.js')
    const { mfaSecretBox, totpSecretOwner } = await import('./mfa-secret-box.js')
    const { generateTotpSecret, hotp, totpStepAt } = await import('./totp.js')
    const { mfaTicketStore } = await import('./mfa-ticket.js')
    const { default: mfaConfig } = await import('#config/mfa.js')
    /** Past the reservation TTL: the capture finds the reservation lapsed. */
    const PAST_RESERVATION_MS = (mfaConfig.reservationTtlSeconds + 5) * 1000

    await import('#app/start/index.js')

    const admin = createTestRedis(PREFIX)
    const PASSWORD = 'mfa-secret-123'
    const createdUserIds: bigint[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined
    const MFA_COOKIE = mfaTicketCookieName()

    interface Reply {
        status: number
        body: Record<string, unknown>
        cookies: Map<string, string>
    }

    class Browser {
        cookies = new Map<string, string>()
        csrf: string | undefined

        async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
            const headers: Record<string, string> = { origin: ORIGIN }
            if (this.cookies.size > 0) {
                headers['cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
            }
            if (this.csrf !== undefined) headers['x-csrf-token'] = this.csrf
            if (body !== undefined) headers['content-type'] = 'application/json'
            const response = await fetch(`http://127.0.0.1:${String(PORT)}/api${path}`, {
                method,
                headers,
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            })
            const text = await response.text()
            const cookies = new Map<string, string>()
            for (const line of response.headers.getSetCookie()) {
                const [pair] = line.split(';')
                const index = (pair ?? '').indexOf('=')
                cookies.set((pair ?? '').slice(0, index), (pair ?? '').slice(index + 1))
            }
            return {
                status: response.status,
                body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
                cookies,
            }
        }

        keep(reply: Reply): Reply {
            for (const [name, value] of reply.cookies) {
                if (value === '') this.cookies.delete(name)
                else this.cookies.set(name, value)
            }
            if (typeof reply.body['csrfToken'] === 'string') this.csrf = reply.body['csrfToken']
            return reply
        }

        async firstFactor(email: string): Promise<Reply> {
            this.keep(await this.request('GET', '/main/init'))
            return this.keep(
                await this.request('POST', '/auth/login', {
                    identifier: email,
                    password: PASSWORD,
                }),
            )
        }

        /** The ticket this browser holds, as stored. */
        ticket() {
            return mfaTicketStore.read(this.cookies.get(MFA_COOKIE) ?? '')
        }

        sessionId(): string {
            const value = Buffer.from(this.cookies.get(sessionConfig.cookieName) ?? '', 'base64')
            return value.toString().split('.')[1] ?? ''
        }
    }

    /** A verified account with a password, TOTP (its secret returned) and recovery codes. */
    const mfaUser = async (name: string) => {
        const [row] = await db
            .insert(users)
            .values({
                name,
                email: `${name}-${crypto.randomUUID()}@example.test`,
                password: await hashPassword(PASSWORD),
                emailVerifiedAt: new Date(),
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        const secret = generateTotpSecret()
        const box = mfaSecretBox()
        if (box === null) throw new Error('no MFA key')
        const sealed = box.seal(secret, totpSecretOwner(row.id))
        const codes = await withTransaction(async (tx) => {
            await totpFactorRepository.replace(
                {
                    userId: row.id,
                    enrollmentId: crypto.randomUUID().slice(0, 32),
                    secretCiphertext: sealed.ciphertext,
                    keyId: sealed.keyId,
                    lastUsedStep: 0n,
                    confirmedAt: new Date(),
                },
                tx,
            )
            return recoveryCodes.issue(row.id, tx)
        })
        const code = (offset = 0n) => hotp(secret, totpStepAt(Date.now()) + offset)
        return { row, email: row.email ?? '', code, codes }
    }

    const unusedCodes = async (userId: bigint) =>
        (
            await db
                .select()
                .from(mfaRecoveryCodes)
                .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))
        ).length

    const tokenOf = async (userId: bigint) =>
        (await db.select().from(users).where(eq(users.id, userId)))[0]?.sessionToken ?? ''

    beforeAll(async () => {
        await admin.connect()
        await redisClient.connect()
        const { routesHandler } = await import('#vendor/start/router.js')
        const { default: httpRoutes } = await import('#app/routes/http-routes.js')
        const server = await import('#vendor/start/server.js')
        stopServer = server.stopServer
        await server.initServer({
            httpRoutes: routesHandler(httpRoutes),
            wsRoutesByUrl: new Map(),
            sourceHttpRoutes: httpRoutes,
            sourceWsRoutes: [],
        } as never)
    })

    afterEach(() => {
        inject.prepare = false
        inject.activate = false
        inject.lostCommitAnswer = false
        inject.rollbackAfterWork = false
        inject.clockJumpMs = 0
        inject.statusUnknown = 0
        inject.statusReads = 0
        inject.claim = false
        inject.cleanup = false
        proxy.disarm()
        security.mockClear()
        newSignIn.mockClear()
    })

    afterAll(async () => {
        await stopServer?.('test')
        for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id))
        await cleanupTestRedis(admin)
        redisHealth.stop()
        redisClient.disconnect(false)
        await admin.quit()
        await sessionCheckPool.end()
        await pool.end()
        await proxy.stop()
    })

    it('the password opens a ticket, not a session; the right code signs in at level 2', async () => {
        const user = await mfaUser('mfa-happy')
        const browser = new Browser()
        const first = await browser.firstFactor(user.email)
        expect(first.status).toBe(200)
        expect(first.body).toMatchObject({
            status: 'mfa_required',
            methods: ['totp', 'recovery_code'],
        })
        expect(browser.cookies.get(MFA_COOKIE)).toMatch(/^[\w-]{43}$/)
        expect((await browser.request('GET', '/main/init')).status).toBe(401)

        const wrong = await browser.request('POST', '/auth/mfa/verify', {
            method: 'totp',
            code: '000000',
        })
        expect(wrong.status).toBe(401)
        expect(wrong.body).toMatchObject({ reason: 'invalid_code' })

        const ok = browser.keep(
            await browser.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: user.code(),
            }),
        )
        expect(ok.status).toBe(200)
        expect(ok.body).toMatchObject({ status: 'success', user: { id: String(user.row.id) } })
        // Р8: only a recovery session carries the recovery state.
        expect(ok.body).not.toHaveProperty('recovery')
        expect(browser.keep(await browser.request('GET', '/main/init')).status).toBe(200)
        const session = await getSession(browser.sessionId(), user.row.sessionToken)
        expect(session?.data.auth).toMatchObject({ aal: 2, amr: ['pwd', 'otp'] })
        expect(newSignIn).toHaveBeenCalledTimes(1)
        // The browser came back with the new session: the ticket is retired with its cookie.
        expect(browser.cookies.has(MFA_COOKIE)).toBe(false)
    })

    it('five wrong codes end the ticket; the ticket cookie of another browser opens nothing', async () => {
        const user = await mfaUser('mfa-wrong')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const thief = new Browser()
        thief.keep(await thief.request('GET', '/main/init'))
        thief.cookies.set(MFA_COOKIE, browser.cookies.get(MFA_COOKIE) ?? '')
        const stolen = await thief.request('POST', '/auth/mfa/verify', {
            method: 'totp',
            code: user.code(),
        })
        expect(stolen.status).toBe(401)
        expect(stolen.body).toMatchObject({ reason: 'mfa_ticket_invalid' })

        for (let i = 0; i < 5; i++) {
            const reply = await browser.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: '111111',
            })
            expect(reply.body).toMatchObject({ reason: 'invalid_code' })
        }
        const after = await browser.request('POST', '/auth/mfa/verify', {
            method: 'totp',
            code: user.code(),
        })
        expect(after.body).toMatchObject({ reason: 'mfa_ticket_invalid' })
    })

    it('two right proofs at once: one session; the proof of the other is given back', async () => {
        const user = await mfaUser('mfa-race')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const before = await unusedCodes(user.row.id)
        const replies = await Promise.all([
            browser.request('POST', '/auth/mfa/verify', { method: 'totp', code: user.code() }),
            browser.request('POST', '/auth/mfa/verify', {
                method: 'recovery_code',
                code: user.codes[0] ?? '',
            }),
        ])
        const statuses = replies.map((reply) => reply.status).sort()
        expect(statuses[0]).toBe(200)
        const loser = replies.find((reply) => reply.status !== 200)
        if (loser !== undefined) {
            expect(['mfa_ticket_used', 'mfa_attempt_expired']).toContain(loser.body['reason'])
        }
        const winner = replies.find((reply) => reply.status === 200)
        const codeSpent = before - (await unusedCodes(user.row.id))
        // Exactly one proof spent: the recovery code only if it won.
        const recoveryWon = winner === replies[1]
        expect(codeSpent).toBe(recoveryWon ? 1 : 0)
    })

    it('a session_token rotated between the steps refuses the sign-in', async () => {
        const user = await mfaUser('mfa-rotated')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        await db
            .update(users)
            .set({ sessionToken: crypto.randomUUID().slice(0, 24) })
            .where(eq(users.id, user.row.id))
        const reply = await browser.request('POST', '/auth/mfa/verify', {
            method: 'totp',
            code: user.code(),
        })
        expect(reply.status).toBe(401)
        expect(reply.body).toMatchObject({ reason: 'session_revoked' })
    })

    it('Redis down while preparing: nothing spent, the same last recovery code works again', async () => {
        const user = await mfaUser('mfa-prepare')
        // Leave a single code: the last one.
        await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.row.id))
        const [last] = await withTransaction((tx) => recoveryCodes.issue(user.row.id, tx))
        await db
            .delete(mfaRecoveryCodes)
            .where(and(eq(mfaRecoveryCodes.userId, user.row.id), isNull(mfaRecoveryCodes.usedAt)))
        const lastCode = last ?? ''
        await withTransaction(async (tx) => {
            const { recoveryCodeRepository } = await import('#app/repositories/index.js')
            const { normalizeRecoveryCode, hashRecoveryCode } = await import('./recovery-codes.js')
            await recoveryCodeRepository.replaceBatch(
                user.row.id,
                [hashRecoveryCode(normalizeRecoveryCode(lastCode) ?? '')],
                'last',
                tx,
            )
        })
        const tokenBefore = await tokenOf(user.row.id)
        const browser = new Browser()
        await browser.firstFactor(user.email)

        inject.prepare = true
        const failed = await browser.request('POST', '/auth/mfa/verify', {
            method: 'recovery_code',
            code: lastCode,
        })
        expect(failed.status).toBe(503)
        expect(await unusedCodes(user.row.id)).toBe(1)
        expect(await tokenOf(user.row.id)).toBe(tokenBefore)

        const ok = browser.keep(
            await browser.request('POST', '/auth/mfa/verify', {
                method: 'recovery_code',
                code: lastCode,
            }),
        )
        expect(ok.status).toBe(200)
        expect(await unusedCodes(user.row.id)).toBe(0)
        // A recovery sign-in rotates the token and opens a recovery session.
        const rotated = await tokenOf(user.row.id)
        expect(rotated).not.toBe(tokenBefore)
        const session = await getSession(browser.sessionId(), rotated)
        expect(session?.data.auth).toMatchObject({ aal: 1, amr: ['pwd', 'recovery'] })
        expect(session?.data.auth?.recovery?.expiresAt).toEqual(expect.any(String))
        expect(security).toHaveBeenCalledWith(user.row.id, 'recovery_code_used')
    })

    it('a lost answer after the activation: the repeat gives the same session, one notice', async () => {
        const user = await mfaUser('mfa-lost-answer')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const body = { method: 'totp', code: user.code() }
        // The answer of the first request never reaches the browser (not kept).
        const first = await browser.request('POST', '/auth/mfa/verify', body)
        expect(first.status).toBe(200)
        const repeat = browser.keep(await browser.request('POST', '/auth/mfa/verify', body))
        expect(repeat.status).toBe(200)
        const firstCookie = first.cookies.get(sessionConfig.cookieName)
        expect(browser.cookies.get(sessionConfig.cookieName)).toBe(firstCookie)
        expect(newSignIn).toHaveBeenCalledTimes(1)
    })

    it('two continuations after the commit: one session, one notice', async () => {
        const user = await mfaUser('mfa-two-continuations')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const body = { method: 'totp', code: user.code() }
        inject.activate = () => Promise.resolve()
        const pending = await browser.request('POST', '/auth/mfa/verify', body)
        expect(pending.status).toBe(503)
        expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
        const replies = await Promise.all([
            browser.request('POST', '/auth/mfa/verify', body),
            browser.request('POST', '/auth/mfa/verify', body),
        ])
        expect(replies.map((reply) => reply.status)).toEqual([200, 200])
        const [a, b] = replies
        expect(a.cookies.get(sessionConfig.cookieName)).toBe(
            b.cookies.get(sessionConfig.cookieName),
        )
        expect(newSignIn).toHaveBeenCalledTimes(1)
    })

    it('a request of an older MFA session during a new second step keeps the new ticket cookie; continue signs in', async () => {
        const earlier = await mfaUser('mfa-older-session')
        const later = await mfaUser('mfa-newer-step')
        const browser = new Browser()
        await browser.firstFactor(earlier.email)
        const signedIn = browser.keep(
            await browser.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: earlier.code(),
            }),
        )
        expect(signedIn.status).toBe(200)
        // The browser came back with that session: its ticket is retired with the cookie.
        browser.keep(await browser.request('GET', '/main/init'))
        expect(browser.cookies.has(MFA_COOKIE)).toBe(false)
        const olderSession = browser.sessionId()

        // A new sign-in in the same browser: a new ticket, its activation not finished yet.
        await browser.firstFactor(later.email)
        const ticketCookie = browser.cookies.get(MFA_COOKIE)
        expect(ticketCookie).toMatch(/^[\w-]{43}$/)
        inject.activate = () => Promise.resolve()
        const pending = browser.keep(
            await browser.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: later.code(),
            }),
        )
        expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
        // Requests of the older session (its completion is another one) leave the new ticket.
        const other = browser.keep(await browser.request('GET', '/main/init'))
        expect(other.status).toBe(200)
        expect(other.cookies.has(MFA_COOKIE)).toBe(false)
        expect(browser.sessionId()).toBe(olderSession)
        expect(browser.cookies.get(MFA_COOKIE)).toBe(ticketCookie)
        expect((await browser.ticket())?.state).toBe('completing')

        const done = browser.keep(
            await browser.request('POST', '/auth/mfa/verify', { method: 'continue' }),
        )
        expect(done.status).toBe(200)
        expect(done.body).toMatchObject({ status: 'success', user: { id: String(later.row.id) } })
        // Now the browser comes back with the new session: that ticket is retired.
        browser.keep(await browser.request('GET', '/main/init'))
        expect(browser.cookies.has(MFA_COOKIE)).toBe(false)
    })

    it('a rotation after the commit and before the first activation: 401, no session', async () => {
        const user = await mfaUser('mfa-rotate-after-commit')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const body = { method: 'totp', code: user.code() }
        let plannedSession = ''
        inject.activate = async () => {
            // logout-all from another device lands between the commit and the activation.
            await db
                .update(users)
                .set({ sessionToken: crypto.randomUUID().slice(0, 24) })
                .where(eq(users.id, user.row.id))
            plannedSession = 'set'
        }
        expect((await browser.request('POST', '/auth/mfa/verify', body)).status).toBe(503)
        expect(plannedSession).toBe('set')
        const reply = await browser.request('POST', '/auth/mfa/verify', body)
        expect(reply.status).toBe(401)
        expect(reply.body).toMatchObject({ reason: 'session_revoked' })
        expect(newSignIn).not.toHaveBeenCalled()
        const pendingKeys = await admin.keys(`session:${user.row.sessionToken}:*`)
        expect(pendingKeys).toEqual([])
    })

    it('a COMMIT whose answer was lost but that committed: reconciled, signed in', async () => {
        const user = await mfaUser('mfa-lost-commit')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        inject.lostCommitAnswer = true
        const reply = browser.keep(
            await browser.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: user.code(),
            }),
        )
        expect(reply.status).toBe(200)
        expect((await browser.request('GET', '/main/init')).status).toBe(200)
    })

    // Р4 with a real failure: the connection drops while COMMIT is answered (the proxy forwards
    // the COMMIT, the server commits, the answer never reaches the pool).
    it('a connection dropped during COMMIT: reconciled by pg_xact_status, the repeat gives the same session', async () => {
        const user = await mfaUser('mfa-commit-drop')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const body = { method: 'totp', code: user.code() }
        const dropped = proxy.dropped
        proxy.arm()
        // The answer of the first request never reaches the browser either (not kept).
        const first = await browser.request('POST', '/auth/mfa/verify', body)
        expect(proxy.dropped).toBe(dropped + 1)
        expect(inject.statusReads).toBeGreaterThan(0)
        expect(first.status).toBe(200)
        const firstCookie = first.cookies.get(sessionConfig.cookieName)
        expect(firstCookie).toEqual(expect.any(String))

        const repeat = browser.keep(await browser.request('POST', '/auth/mfa/verify', body))
        expect(repeat.status).toBe(200)
        expect(browser.cookies.get(sessionConfig.cookieName)).toBe(firstCookie)
        expect(browser.keep(await browser.request('GET', '/main/init')).status).toBe(200)
        const session = await getSession(browser.sessionId(), user.row.sessionToken)
        expect(session?.data.auth).toMatchObject({ aal: 2, amr: ['pwd', 'otp'] })
        expect(newSignIn).toHaveBeenCalledTimes(1)
    })

    it('a connection dropped during COMMIT of a recovery code: the code spent once, one session', async () => {
        const user = await mfaUser('mfa-commit-drop-recovery')
        const tokenBefore = await tokenOf(user.row.id)
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const body = { method: 'recovery_code', code: user.codes[3] ?? '' }
        const dropped = proxy.dropped
        proxy.arm()
        const first = await browser.request('POST', '/auth/mfa/verify', body)
        expect(proxy.dropped).toBe(dropped + 1)
        expect(inject.statusReads).toBeGreaterThan(0)
        expect(first.status).toBe(200)
        expect(await unusedCodes(user.row.id)).toBe(9)

        const repeat = browser.keep(await browser.request('POST', '/auth/mfa/verify', body))
        expect(repeat.status).toBe(200)
        expect(browser.cookies.get(sessionConfig.cookieName)).toBe(
            first.cookies.get(sessionConfig.cookieName),
        )
        expect(await unusedCodes(user.row.id)).toBe(9)
        const rotated = await tokenOf(user.row.id)
        expect(rotated).not.toBe(tokenBefore)
        const session = await getSession(browser.sessionId(), rotated)
        expect(session?.data.auth).toMatchObject({ aal: 1, amr: ['pwd', 'recovery'] })
        expect(
            security.mock.calls.filter(([, kind]) => kind === 'recovery_code_used'),
        ).toHaveLength(1)
        expect(newSignIn).toHaveBeenCalledTimes(1)
    })

    it('work done and rolled back without an answer: aborted, the same code works again', async () => {
        const user = await mfaUser('mfa-aborted')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const code = user.codes[1] ?? ''
        inject.rollbackAfterWork = true
        const failed = await browser.request('POST', '/auth/mfa/verify', {
            method: 'recovery_code',
            code,
        })
        expect(failed.status).toBe(503)
        expect(await unusedCodes(user.row.id)).toBe(10)
        const ok = await browser.request('POST', '/auth/mfa/verify', {
            method: 'recovery_code',
            code,
        })
        expect(ok.status).toBe(200)
        expect(await unusedCodes(user.row.id)).toBe(9)
    })

    it('a reservation that lapsed before the capture: 401, the TOTP step not spent', async () => {
        const user = await mfaUser('mfa-expired-totp')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const body = { method: 'totp', code: user.code() }
        inject.clockJumpMs = PAST_RESERVATION_MS
        const late = await browser.request('POST', '/auth/mfa/verify', body)
        expect(late.status).toBe(401)
        expect(late.body).toMatchObject({ reason: 'mfa_attempt_expired' })
        expect(await browser.ticket()).toMatchObject({ state: 'open', failures: 0 })
        expect(newSignIn).not.toHaveBeenCalled()
        // The same code again: its step was rolled back with the attempt.
        const ok = browser.keep(await browser.request('POST', '/auth/mfa/verify', body))
        expect(ok.status).toBe(200)
    })

    it('a reservation that lapsed before the capture: the recovery code not spent', async () => {
        const user = await mfaUser('mfa-expired-recovery')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const tokenBefore = await tokenOf(user.row.id)
        const body = { method: 'recovery_code', code: user.codes[2] ?? '' }
        inject.clockJumpMs = PAST_RESERVATION_MS
        const late = await browser.request('POST', '/auth/mfa/verify', body)
        expect(late.status).toBe(401)
        expect(late.body).toMatchObject({ reason: 'mfa_attempt_expired' })
        expect(await unusedCodes(user.row.id)).toBe(10)
        expect(await tokenOf(user.row.id)).toBe(tokenBefore)
        expect(await browser.ticket()).toMatchObject({ state: 'open', failures: 0 })
        const ok = await browser.request('POST', '/auth/mfa/verify', body)
        expect(ok.status).toBe(200)
        expect(await unusedCodes(user.row.id)).toBe(9)
    })

    it('a code continuation that finds a rollback: the same request signs in', async () => {
        const user = await mfaUser('mfa-continue-aborted')
        const browser = new Browser()
        await browser.firstFactor(user.email)
        const body = { method: 'totp', code: user.code() }
        // The work ran, the transaction rolled back, and its status could not be read.
        inject.rollbackAfterWork = true
        inject.statusUnknown = 1
        const pending = await browser.request('POST', '/auth/mfa/verify', body)
        expect(pending.status).toBe(503)
        expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
        expect(await browser.ticket()).toMatchObject({ state: 'completing' })
        const ok = browser.keep(await browser.request('POST', '/auth/mfa/verify', body))
        expect(ok.status).toBe(200)
        expect(newSignIn).toHaveBeenCalledTimes(1)
    })

    // Р8 acceptance (tasks M9): the only TOTP lost, the last recovery code, a TOTP replaced in
    // the recovery session, new codes, the recovery finished, an ordinary sign-in with the new app.
    it('recovery: single TOTP lost, last code, replace, new codes, finish, sign in again', async () => {
        const user = await mfaUser('mfa-recovery-path')
        const last = user.codes[9] ?? ''
        const { recoveryCodeRepository } = await import('#app/repositories/index.js')
        const { normalizeRecoveryCode, hashRecoveryCode } = await import('./recovery-codes.js')
        await withTransaction((tx) =>
            recoveryCodeRepository.replaceBatch(
                user.row.id,
                [hashRecoveryCode(normalizeRecoveryCode(last) ?? '')],
                'only',
                tx,
            ),
        )
        const browser = new Browser()
        await browser.firstFactor(user.email)
        expect(
            browser.keep(
                await browser.request('POST', '/auth/mfa/verify', {
                    method: 'recovery_code',
                    code: last,
                }),
            ).status,
        ).toBe(200)

        // A recovery session: no WebSocket, only the recovery routes.
        const init = browser.keep(await browser.request('GET', '/main/init'))
        expect(init.status).toBe(200)
        expect(init.body).toMatchObject({ wsToken: null, recovery: { replaced: false } })
        for (const [method, path] of [
            ['GET', '/account/profile'],
            ['GET', '/account/sessions'],
            ['POST', '/auth/login'],
        ] as const) {
            const refused = await browser.request(
                method,
                path,
                method === 'POST' ? { identifier: user.email, password: PASSWORD } : undefined,
            )
            expect(refused.status, path).toBe(403)
            expect(refused.body, path).toMatchObject({ reason: 'recovery_session' })
        }
        // R: removing the lost factor or new codes wait for the replacement.
        expect(
            (await browser.request('POST', '/account/mfa/recovery-codes', {})).body,
        ).toMatchObject({ reason: 'recovery_session' })

        const setup = browser.keep(await browser.request('POST', '/account/mfa/totp/setup', {}))
        expect(setup.status).toBe(200)
        const { base32Decode } = await import('./totp.js')
        const newSecret = base32Decode(String(setup.body['secret']))
        const confirmed = browser.keep(
            await browser.request('POST', '/account/mfa/totp/confirm', {
                enrollmentId: setup.body['enrollmentId'],
                code: hotp(newSecret, totpStepAt(Date.now())),
            }),
        )
        expect(confirmed.status).toBe(200)
        // The old secret no longer works: the factor is the new version.
        const afterReplace = browser.keep(await browser.request('GET', '/main/init'))
        expect(afterReplace.body).toMatchObject({ recovery: { replaced: true } })
        const codes = browser.keep(await browser.request('POST', '/account/mfa/recovery-codes', {}))
        expect(codes.status).toBe(200)
        expect(codes.body['recoveryCodes']).toHaveLength(10)
        expect(
            browser.keep(await browser.request('POST', '/auth/recovery/finish', {})).status,
        ).toBe(200)
        expect((await browser.request('GET', '/main/init')).status).toBe(401)

        // An ordinary sign-in: password and the new app; the old app is refused.
        const again = new Browser()
        await again.firstFactor(user.email)
        const oldCode = await again.request('POST', '/auth/mfa/verify', {
            method: 'totp',
            code: user.code(1n),
        })
        expect(oldCode.body).toMatchObject({ reason: 'invalid_code' })
        const signedIn = again.keep(
            await again.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: hotp(newSecret, totpStepAt(Date.now()) + 1n),
            }),
        )
        expect(signedIn.status).toBe(200)
        const session = await getSession(again.sessionId(), await tokenOf(user.row.id))
        expect(session?.data.auth).toMatchObject({ aal: 2, amr: ['pwd', 'otp'] })
    })

    describe('the state of the second step after a reload (POST /auth/mfa/state)', () => {
        it('an open ticket of this browser: its methods; no, a foreign or a gone ticket: none', async () => {
            const user = await mfaUser('mfa-state-open')
            const browser = new Browser()
            await browser.firstFactor(user.email)
            const state = await browser.request('POST', '/auth/mfa/state', {})
            expect(state.status).toBe(200)
            expect(state.body).toEqual({
                status: 'mfa_required',
                methods: ['totp', 'recovery_code'],
            })
            const before = await browser.ticket()

            // A browser without a ticket cookie.
            const stranger = new Browser()
            stranger.keep(await stranger.request('GET', '/main/init'))
            const none = await stranger.request('POST', '/auth/mfa/state', {})
            expect(none.status).toBe(200)
            expect(none.body).toEqual({ status: 'none' })

            // The ticket cookie of this browser in another one: nothing about it.
            stranger.cookies.set(MFA_COOKIE, browser.cookies.get(MFA_COOKIE) ?? '')
            const foreign = await stranger.request('POST', '/auth/mfa/state', {})
            expect(foreign.status).toBe(200)
            expect(foreign.body).toEqual({ status: 'none' })

            // Asking changes nothing: no failure counted, the ticket still open.
            expect(await browser.ticket()).toEqual(before)
            const ok = await browser.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: user.code(),
            })
            expect(ok.status).toBe(200)

            // A ticket that is gone (here: retired by the sign-in) is none.
            const gone = new Browser()
            await gone.firstFactor(user.email)
            await mfaTicketStore.delete(gone.cookies.get(MFA_COOKIE) ?? '')
            expect((await gone.request('POST', '/auth/mfa/state', {})).body).toEqual({
                status: 'none',
            })
        })

        it('a completing ticket: completing, and continue finishes it (no recovery state)', async () => {
            const user = await mfaUser('mfa-state-completing')
            const browser = new Browser()
            await browser.firstFactor(user.email)
            inject.activate = () => Promise.resolve()
            const pending = await browser.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: user.code(),
            })
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })

            // The page reloads: the request is lost, the ticket cookie is not.
            const state = await browser.request('POST', '/auth/mfa/state', {})
            expect(state.body).toEqual({
                status: 'mfa_required',
                methods: ['totp', 'recovery_code'],
                completing: true,
            })
            const done = browser.keep(
                await browser.request('POST', '/auth/mfa/verify', { method: 'continue' }),
            )
            expect(done.status).toBe(200)
            expect(done.body).toMatchObject({ status: 'success' })
            expect(done.body).not.toHaveProperty('recovery')
            expect(newSignIn).toHaveBeenCalledTimes(1)
        })
    })

    describe('the recovery state in the answer of the second step (Р8)', () => {
        it('a recovery code answers the recovery session at once', async () => {
            const user = await mfaUser('mfa-recovery-answer')
            const browser = new Browser()
            await browser.firstFactor(user.email)
            const reply = browser.keep(
                await browser.request('POST', '/auth/mfa/verify', {
                    method: 'recovery_code',
                    code: user.codes[0] ?? '',
                }),
            )
            expect(reply.status).toBe(200)
            const recovery = reply.body['recovery'] as { expiresAt: string; replaced: boolean }
            expect(recovery).toEqual({ expiresAt: expect.any(String), replaced: false })
            expect(Date.parse(recovery.expiresAt)).toBeGreaterThan(Date.now())
            // The same state main/init gives.
            const init = await browser.request('GET', '/main/init')
            expect(init.body['recovery']).toEqual(recovery)
        })

        it('continue of a recovery ticket carries it too', async () => {
            const user = await mfaUser('mfa-recovery-continue')
            const browser = new Browser()
            await browser.firstFactor(user.email)
            inject.activate = () => Promise.resolve()
            const pending = await browser.request('POST', '/auth/mfa/verify', {
                method: 'recovery_code',
                code: user.codes[0] ?? '',
            })
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
            const done = await browser.request('POST', '/auth/mfa/verify', { method: 'continue' })
            expect(done.status).toBe(200)
            expect(done.body['recovery']).toEqual({
                expiresAt: expect.any(String),
                replaced: false,
            })
        })
    })

    // Р4, Р8, Р13 (review of feat-253): a failure of the activation's tail answers 503
    // `mfa_completion_pending`, and the browser repeats with the cookies and the CSRF token it
    // actually holds. Everything that can fail runs before its previous session is deleted, so
    // that session (the CSRF token, the ticket's binding) is still there for the repeat.
    describe('a failed activation tail repeated by the browser itself (Р4, Р8, Р13)', async () => {
        const { wsConnectionRegistry } = await import('#app/websocket/ws-connection-registry.js')
        const { registerSessionDeletionLock } =
            await import('#vendor/utils/session/session-deletion-lock.js')
        const { underUserRowLock } = await import('#app/services/user/session-list-service.js')
        const { sessionExists } = await import('#vendor/utils/session/redis-session-storage.js')

        afterEach(() => {
            registerSessionDeletionLock(underUserRowLock)
        })

        /** POST /auth/mfa/verify, its answer kept as a browser keeps it. */
        const verify = async (browser: Browser, body: unknown) =>
            browser.keep(await browser.request('POST', '/auth/mfa/verify', body))
        const CONTINUE = { method: 'continue' }

        /** The repeat signs in: the browser holds the new session, and it opens the app. */
        const expectSignedIn = async (browser: Browser, reply: Reply, userId: bigint) => {
            expect(reply.status).toBe(200)
            expect(reply.body).toMatchObject({ status: 'success', user: { id: String(userId) } })
            const init = browser.keep(await browser.request('GET', '/main/init'))
            expect(init.status).toBe(200)
            expect(await getSession(browser.sessionId(), await tokenOf(userId))).not.toBeNull()
        }

        /**
         * A browser signed in (password) to an account without a second factor: its session has a
         * stored record, which the next sign-in in it replaces. (A cookie-held anonymous session
         * has none to lose.)
         */
        const signedInBrowser = async () => {
            const [row] = await db
                .insert(users)
                .values({
                    name: 'mfa-tail-plain',
                    email: `mfa-tail-plain-${crypto.randomUUID()}@example.test`,
                    password: await hashPassword(PASSWORD),
                    emailVerifiedAt: new Date(),
                })
                .returning()
            if (row === undefined) throw new Error('user not inserted')
            createdUserIds.push(row.id)
            const browser = new Browser()
            expect((await browser.firstFactor(row.email ?? '')).body).toMatchObject({
                status: 'success',
            })
            browser.keep(await browser.request('GET', '/main/init'))
            const sessionId = browser.sessionId()
            expect(await sessionExists(sessionId, row.sessionToken)).toBe(true)
            // Its own sign-in notice is not the one counted below.
            newSignIn.mockClear()
            return {
                browser,
                /** Whether the record of that signed-in session is still stored. */
                stored: () => sessionExists(sessionId, row.sessionToken),
            }
        }

        /** A fake socket of `userId` registered on this instance; `ended` tells its close. */
        const fakeSocket = (userId: bigint, sessionId: string, userToken: string) => {
            const ended: number[] = []
            const ws = {
                cork: (fn: () => void): void => {
                    fn()
                },
                send: (): void => undefined,
                end: (code: number): void => {
                    ended.push(code)
                },
            }
            const uuid = crypto.randomUUID()
            wsConnectionRegistry.registerConnection(String(userId), uuid, ws as never, {
                ip: '203.0.113.9',
                userAgent: 'test',
                appType: 'web',
                sessionId,
                userToken,
            })
            return {
                ended,
                remove: () => wsConnectionRegistry.unregisterConnection(String(userId), uuid),
            }
        }

        it('(a) a claim that fails: the browser’s continue with its own cookies signs in, one notice', async () => {
            const user = await mfaUser('mfa-tail-claim')
            const { browser, stored } = await signedInBrowser()
            await browser.firstFactor(user.email)
            const before = browser.sessionId()
            const csrfBefore = browser.csrf

            inject.claim = true
            const pending = await verify(browser, { method: 'totp', code: user.code() })
            expect(pending.status).toBe(503)
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
            // No new cookie: the browser still holds its session and its CSRF token.
            expect(browser.sessionId()).toBe(before)
            expect(browser.csrf).toBe(csrfBefore)
            expect(await stored()).toBe(true)
            expect(newSignIn).not.toHaveBeenCalled()

            const done = await verify(browser, CONTINUE)
            await expectSignedIn(browser, done, user.row.id)
            expect(browser.sessionId()).not.toBe(before)
            expect(await stored()).toBe(false)
            expect(newSignIn).toHaveBeenCalledTimes(1)
        })

        it('(b) a recovery cleanup that fails: the browser’s continue signs in; the rotated token’s sessions are gone, a new-token socket survives', async () => {
            const user = await mfaUser('mfa-tail-cleanup')
            // A session of the token the recovery sign-in rotates away (the lost device).
            const lost = new Browser()
            await lost.firstFactor(user.email)
            expect((await verify(lost, { method: 'totp', code: user.code() })).status).toBe(200)
            const oldToken = await tokenOf(user.row.id)
            const lostSession = lost.sessionId()
            expect(await sessionExists(lostSession, oldToken)).toBe(true)
            newSignIn.mockClear()

            const { browser, stored } = await signedInBrowser()
            await browser.firstFactor(user.email)
            const before = browser.sessionId()
            inject.cleanup = true
            const pending = await verify(browser, {
                method: 'recovery_code',
                code: user.codes[0] ?? '',
            })
            expect(pending.status).toBe(503)
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
            expect(browser.sessionId()).toBe(before)
            expect(await stored()).toBe(true)
            expect(newSignIn).not.toHaveBeenCalled()
            const newToken = await tokenOf(user.row.id)
            expect(newToken).not.toBe(oldToken)

            // Between the attempts: a socket of the lost device's token and one of a session
            // signed in with the new token (another tab of the recovery, say).
            const stale = fakeSocket(user.row.id, lostSession, oldToken)
            const fresh = fakeSocket(user.row.id, crypto.randomUUID(), newToken)
            try {
                const done = await verify(browser, CONTINUE)
                expect(done.status).toBe(200)
                expect(stale.ended).toEqual([4001])
                expect(fresh.ended).toEqual([])
            } finally {
                stale.remove()
                fresh.remove()
            }
            expect(await sessionExists(lostSession, oldToken)).toBe(false)
            expect(await getSession(browser.sessionId(), newToken)).not.toBeNull()
            expect(browser.sessionId()).not.toBe(before)
            expect(await stored()).toBe(false)
            expect(newSignIn).toHaveBeenCalledTimes(1)
            expect(security).toHaveBeenCalledWith(user.row.id, 'recovery_code_used')
            expect(
                security.mock.calls.filter((call) => call[1] === 'recovery_code_used'),
            ).toHaveLength(1)
        })

        it('(c) the replaced session’s lock not taken: the browser’s continue replaces it and signs in, one notice', async () => {
            const earlier = await mfaUser('mfa-tail-lock-earlier')
            const later = await mfaUser('mfa-tail-lock-later')
            const browser = new Browser()
            await browser.firstFactor(earlier.email)
            expect((await verify(browser, { method: 'totp', code: earlier.code() })).status).toBe(
                200,
            )
            browser.keep(await browser.request('GET', '/main/init'))
            const earlierSession = browser.sessionId()
            const earlierToken = await tokenOf(earlier.row.id)
            newSignIn.mockClear()

            // A sign-in of another account in the same browser; the signed-in session it replaces
            // is deleted under its user's row lock, which is not taken (Р13).
            await browser.firstFactor(later.email)
            let refusals = 0
            registerSessionDeletionLock(() => {
                refusals += 1
                return Promise.reject(new Error('lock held'))
            })
            const pending = await verify(browser, { method: 'totp', code: later.code() })
            expect(pending.status).toBe(503)
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
            expect(refusals).toBe(1)
            expect(browser.sessionId()).toBe(earlierSession)
            expect(await sessionExists(earlierSession, earlierToken)).toBe(true)
            // The claim ran before the deletion: the notice is out, once.
            expect(newSignIn).toHaveBeenCalledTimes(1)

            registerSessionDeletionLock(underUserRowLock)
            const done = await verify(browser, CONTINUE)
            await expectSignedIn(browser, done, later.row.id)
            expect(await sessionExists(earlierSession, earlierToken)).toBe(false)
            expect(newSignIn).toHaveBeenCalledTimes(1)
        })
    })

    it('an account without a second factor signs in with the password alone, as before', async () => {
        const [row] = await db
            .insert(users)
            .values({
                name: 'no-mfa',
                email: `no-mfa-${crypto.randomUUID()}@example.test`,
                password: await hashPassword(PASSWORD),
                emailVerifiedAt: new Date(),
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        const browser = new Browser()
        const reply = await browser.firstFactor(row.email ?? '')
        expect(reply.body).toMatchObject({ status: 'success' })
        expect(browser.cookies.has(MFA_COOKIE)).toBe(false)
        const session = await getSession(browser.sessionId(), row.sessionToken)
        expect(session?.data.auth).toMatchObject({ aal: 1, amr: ['pwd'] })
    })

    // feat-246 (Р4, Р6; tasks P4): a passkey as the second step, through the same ticket.
    describe('a passkey as the second step (feat-246 P4)', async () => {
        const { default: webauthnConfig } = await import('#config/webauthn.js')
        const { webauthnCredentialRepository } = await import('#app/repositories/index.js')
        const { registrationOptions, verifyWebAuthnCeremony, ceremonyBinding } =
            await import('./webauthn-ceremony.js')
        const { randomBytes } = await import('node:crypto')
        const RP = webauthnConfig.rpId
        const WEB_ORIGIN = webauthnConfig.origins[0] ?? ''

        /** Adds a passkey to `userId` through the real registration ceremony. */
        const addPasskey = async (userId: bigint, counter = 0) => {
            const authenticator = new SoftAuthenticator({ counter })
            const handle = await withTransaction((tx) =>
                webauthnCredentialRepository.ensureUserHandle(userId, randomBytes(32), tx),
            )
            const options = await registrationOptions({
                userHandle: handle,
                userName: 'user',
                displayName: 'User',
                exclude: [],
            })
            const binding = ceremonyBinding('register', 'test')
            const verified = await verifyWebAuthnCeremony({
                purpose: 'register',
                stored: { challenge: options.challenge, binding },
                expectedBinding: binding,
                response: authenticator.register({
                    challenge: options.challenge,
                    rpId: RP,
                    origin: WEB_ORIGIN,
                    userHandle: options.user.id,
                }),
            })
            if (!verified.ok || !('registration' in verified)) throw new Error('not registered')
            const key = await withTransaction((tx) =>
                webauthnCredentialRepository.insert(
                    {
                        userId,
                        ...verified.registration,
                        name: 'Key',
                        enrollmentId: crypto.randomUUID().replaceAll('-', ''),
                    },
                    tx,
                ),
            )
            return { authenticator, key }
        }

        /** The ticket's options, answered by `authenticator`. */
        const answer = async (browser: Browser, authenticator: SoftAuthenticator) => {
            const options = await browser.request('POST', '/auth/mfa/webauthn/options', {})
            expect(options.status).toBe(200)
            const challenge = (options.body['options'] as { challenge: string }).challenge
            return authenticator.authenticate({ challenge, rpId: RP, origin: WEB_ORIGIN })
        }

        const { webauthnCredentials } = await import('#database/schema.js')
        const countOf = async (id: bigint) =>
            (await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.id, id)))[0]
                ?.signCount

        it('the passkey is offered first and signs in at level 2 (amr pwd + webauthn)', async () => {
            const user = await mfaUser('mfa-passkey')
            const { authenticator } = await addPasskey(user.row.id, 3)
            const browser = new Browser()
            const first = await browser.firstFactor(user.email)
            expect(first.body).toMatchObject({
                status: 'mfa_required',
                methods: ['webauthn', 'totp', 'recovery_code'],
            })
            const response = await answer(browser, authenticator)
            const ok = browser.keep(
                await browser.request('POST', '/auth/mfa/verify', { method: 'webauthn', response }),
            )
            expect(ok.status).toBe(200)
            const session = await getSession(browser.sessionId(), user.row.sessionToken)
            expect(session?.data.auth).toMatchObject({ aal: 2, amr: ['pwd', 'webauthn'] })
        })

        it("another user's key is a failed attempt; a spent challenge answers nothing", async () => {
            const user = await mfaUser('mfa-passkey-foreign')
            const mine = await addPasskey(user.row.id)
            const other = await mfaUser('mfa-passkey-other')
            const theirs = await addPasskey(other.row.id)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            const foreign = await answer(browser, theirs.authenticator)
            const refused = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: foreign,
            })
            expect(refused.status).toBe(401)
            expect(refused.body).toMatchObject({ reason: 'invalid_code' })

            // The challenge of that attempt is spent: the right key's answer to it fails too.
            const stale = mine.authenticator.authenticate({
                challenge: 'c3BlbnQ',
                rpId: RP,
                origin: WEB_ORIGIN,
            })
            const again = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: stale,
            })
            expect(again.status).toBe(401)

            const fresh = await answer(browser, mine.authenticator)
            const ok = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: fresh,
            })
            expect(ok.status).toBe(200)
        })

        it('a rollback after the work gives the counter back', async () => {
            const user = await mfaUser('mfa-passkey-rollback')
            const { authenticator, key } = await addPasskey(user.row.id, 7)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            const response = await answer(browser, authenticator)
            inject.rollbackAfterWork = true
            const failed = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response,
            })
            expect(failed.status).toBe(503)
            expect(await countOf(key.id)).toBe(7n)
            const retry = await answer(browser, authenticator)
            const ok = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: retry,
            })
            expect(ok.status).toBe(200)
            expect(await countOf(key.id)).toBe(9n)
        })

        it('a reservation that lapsed before the capture: 401, the counter not spent', async () => {
            const user = await mfaUser('mfa-passkey-expired')
            const { authenticator, key } = await addPasskey(user.row.id, 4)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            const response = await answer(browser, authenticator)
            inject.clockJumpMs = PAST_RESERVATION_MS
            const late = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response,
            })
            expect(late.status).toBe(401)
            expect(late.body).toMatchObject({ reason: 'mfa_attempt_expired' })
            expect(await countOf(key.id)).toBe(4n)
            expect(await browser.ticket()).toMatchObject({ state: 'open', failures: 0 })
            // Its challenge was spent: the same answer asks for a new ceremony, counts nothing.
            const again = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response,
            })
            expect(again.body).toMatchObject({ reason: 'mfa_attempt_expired' })
            expect(await browser.ticket()).toMatchObject({ state: 'open', failures: 0 })
            const ok = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: await answer(browser, authenticator),
            })
            expect(ok.status).toBe(200)
            expect(await countOf(key.id)).toBe(6n)
        })

        it('a pending completion: options answer pending, the same answer finishes it', async () => {
            const user = await mfaUser('mfa-passkey-pending')
            const { authenticator } = await addPasskey(user.row.id)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            const body = { method: 'webauthn', response: await answer(browser, authenticator) }
            inject.activate = () => Promise.resolve()
            const pending = await browser.request('POST', '/auth/mfa/verify', body)
            expect(pending.status).toBe(503)
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
            // A new ceremony is not offered while the confirmed attempt finishes.
            const options = await browser.request('POST', '/auth/mfa/webauthn/options', {})
            expect(options.status).toBe(503)
            expect(options.body).toMatchObject({ reason: 'mfa_completion_pending' })
            const ok = browser.keep(await browser.request('POST', '/auth/mfa/verify', body))
            expect(ok.status).toBe(200)
            expect(newSignIn).toHaveBeenCalledTimes(1)
        })

        it('a continuation that finds a rollback: a new ceremony, no failure counted', async () => {
            const user = await mfaUser('mfa-passkey-continue-aborted')
            const { authenticator, key } = await addPasskey(user.row.id, 2)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            const body = { method: 'webauthn', response: await answer(browser, authenticator) }
            inject.rollbackAfterWork = true
            inject.statusUnknown = 1
            const pending = await browser.request('POST', '/auth/mfa/verify', body)
            expect(pending.status).toBe(503)
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
            expect(
                (await browser.request('POST', '/auth/mfa/webauthn/options', {})).body,
            ).toMatchObject({ reason: 'mfa_completion_pending' })

            const rolledBack = await browser.request('POST', '/auth/mfa/verify', body)
            expect(rolledBack.status).toBe(401)
            expect(rolledBack.body).toMatchObject({ reason: 'mfa_attempt_expired' })
            expect(await browser.ticket()).toMatchObject({ state: 'open', failures: 0 })
            expect(await countOf(key.id)).toBe(2n)

            const ok = browser.keep(
                await browser.request('POST', '/auth/mfa/verify', {
                    method: 'webauthn',
                    response: await answer(browser, authenticator),
                }),
            )
            expect(ok.status).toBe(200)
            expect(newSignIn).toHaveBeenCalledTimes(1)
        })

        // Р4: `continue` finishes a confirmed ticket without the answer the browser lost.
        const CONTINUE = { method: 'continue' }

        it('a lost answer of a committed passkey verify: continue gives the same session', async () => {
            const user = await mfaUser('mfa-passkey-continue-lost')
            const { authenticator } = await addPasskey(user.row.id)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            const response = await answer(browser, authenticator)
            // The answer never reaches the browser (not kept); the page reloads.
            const first = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response,
            })
            expect(first.status).toBe(200)
            const options = await browser.request('POST', '/auth/mfa/webauthn/options', {})
            expect(options.body).toMatchObject({ reason: 'mfa_completion_pending' })
            const ok = browser.keep(await browser.request('POST', '/auth/mfa/verify', CONTINUE))
            expect(ok.status).toBe(200)
            expect(browser.cookies.get(sessionConfig.cookieName)).toBe(
                first.cookies.get(sessionConfig.cookieName),
            )
            const session = await getSession(browser.sessionId(), user.row.sessionToken)
            expect(session?.data.auth).toMatchObject({ aal: 2, amr: ['pwd', 'webauthn'] })
            expect(newSignIn).toHaveBeenCalledTimes(1)
        })

        it('a pending activation: continue finishes it, one notice', async () => {
            const user = await mfaUser('mfa-passkey-continue-pending')
            const { authenticator } = await addPasskey(user.row.id)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            inject.activate = () => Promise.resolve()
            const pending = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: await answer(browser, authenticator),
            })
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
            const ok = browser.keep(await browser.request('POST', '/auth/mfa/verify', CONTINUE))
            expect(ok.status).toBe(200)
            expect(browser.keep(await browser.request('GET', '/main/init')).status).toBe(200)
            expect(newSignIn).toHaveBeenCalledTimes(1)
        })

        it('continue of an open ticket proves nothing: 401 mfa_attempt_expired, nothing counted', async () => {
            const user = await mfaUser('mfa-passkey-continue-open')
            const { authenticator } = await addPasskey(user.row.id)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            for (let i = 0; i < 6; i++) {
                const reply = await browser.request('POST', '/auth/mfa/verify', CONTINUE)
                expect(reply.status).toBe(401)
                expect(reply.body).toMatchObject({ reason: 'mfa_attempt_expired' })
            }
            expect(await browser.ticket()).toMatchObject({
                state: 'open',
                failures: 0,
                reservations: [],
            })
            const ok = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: await answer(browser, authenticator),
            })
            expect(ok.status).toBe(200)
        })

        it('continue after a rollback: mfa_attempt_expired, the ticket reopened, a new ceremony works', async () => {
            const user = await mfaUser('mfa-passkey-continue-aborted')
            const { authenticator, key } = await addPasskey(user.row.id, 5)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            inject.rollbackAfterWork = true
            inject.statusUnknown = 1
            const pending = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: await answer(browser, authenticator),
            })
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })

            const rolledBack = await browser.request('POST', '/auth/mfa/verify', CONTINUE)
            expect(rolledBack.status).toBe(401)
            expect(rolledBack.body).toMatchObject({ reason: 'mfa_attempt_expired' })
            expect(await browser.ticket()).toMatchObject({ state: 'open', failures: 0 })
            expect(await countOf(key.id)).toBe(5n)

            const ok = browser.keep(
                await browser.request('POST', '/auth/mfa/verify', {
                    method: 'webauthn',
                    response: await answer(browser, authenticator),
                }),
            )
            expect(ok.status).toBe(200)
            expect(newSignIn).toHaveBeenCalledTimes(1)
        })

        it('continue from another browser: the ticket is invalid there, the owner finishes', async () => {
            const user = await mfaUser('mfa-passkey-continue-thief')
            const { authenticator } = await addPasskey(user.row.id)
            const browser = new Browser()
            await browser.firstFactor(user.email)
            inject.activate = () => Promise.resolve()
            const pending = await browser.request('POST', '/auth/mfa/verify', {
                method: 'webauthn',
                response: await answer(browser, authenticator),
            })
            expect(pending.body).toMatchObject({ reason: 'mfa_completion_pending' })
            const thief = new Browser()
            thief.keep(await thief.request('GET', '/main/init'))
            thief.cookies.set(MFA_COOKIE, browser.cookies.get(MFA_COOKIE) ?? '')
            const stolen = await thief.request('POST', '/auth/mfa/verify', CONTINUE)
            expect(stolen.status).toBe(401)
            expect(stolen.body).toMatchObject({ reason: 'mfa_ticket_invalid' })
            expect(newSignIn).not.toHaveBeenCalled()

            const ok = await browser.request('POST', '/auth/mfa/verify', CONTINUE)
            expect(ok.status).toBe(200)
            expect(newSignIn).toHaveBeenCalledTimes(1)
        })
    })
})
