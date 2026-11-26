import { eq, inArray } from 'drizzle-orm'
import type { NormalizedEmail } from '#app/domain/email.js'
import type { UserId } from '#app/domain/ids.js'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../test-support/pg-test-db.js'
import { hasRedis, REDIS_TEST_URL } from '../test-support/redis-test-client.js'
import { enrollTestTotp } from '../test-support/test-totp.js'

// feat-240 (Р7, T6): user:set-role on a real PostgreSQL and Redis. The CLI process is not an
// instance: its user event bus is never started, so publishToUser would not reach Redis. It
// publishes the server event with publishRemote, which a started instance receives. The CLI code
// runs here as it is (runUserSetRole), on the real, never-started bus of the module.

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    return { PREFIX: `test:${crypto.randomUUID()}:` }
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
// feat-248 (Р10): the staff factor mode is switched per test; the CLI reads it through the policy.
vi.mock('#config/mfa.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return { default: { ...actual.default, requiredForStaff: true, staffFactor: 'any' } }
})

describe.skipIf(!hasPg || !hasRedis)('user:set-role (feat-240)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { auditEvents, users } = await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { USER_EVENTS_CHANNEL } = await import('#app/services/communication/user-event-bus.js')
    const { runUserSetRole } = await import('./user-set-role-cli.js')
    const { webauthnCredentialRepository, withTransaction } =
        await import('#app/repositories/index.js')
    const { default: mfaConfig } = (await import('#config/mfa.js')) as unknown as {
        default: { staffFactor: 'any' | 'passkey' }
    }

    const listener = new Redis(REDIS_TEST_URL ?? 'redis://127.0.0.1:6379', { lazyConnect: true })
    const received: Record<string, unknown>[] = []
    const stamp = String(Date.now())
    const ids: UserId[] = []
    let counter = 0

    const insertUser = async (verified: boolean) => {
        counter += 1
        const email = `cli-role-${String(counter)}-${stamp}@example.test` as NormalizedEmail
        const [row] = await db
            .insert(users)
            .values({ name: 'cli', email, emailVerifiedAt: verified ? new Date() : null })
            .returning({ id: users.id })
        if (row === undefined) throw new Error('user not inserted')
        ids.push(row.id)
        return { id: row.id, email }
    }

    const run = async (argv: string[]) => {
        const lines: string[] = []
        const errors: string[] = []
        const code = await runUserSetRole(argv, {
            print: (line) => lines.push(line),
            printError: (line) => errors.push(line),
        })
        return { code, lines, errors }
    }

    beforeAll(async () => {
        await redisClient.connect()
        await listener.connect()
        listener.on('message', (_channel: string, raw: string) => {
            received.push(JSON.parse(raw) as Record<string, unknown>)
        })
        await listener.subscribe(USER_EVENTS_CHANNEL)
    })

    afterAll(async () => {
        if (ids.length > 0) {
            await db.delete(auditEvents).where(inArray(auditEvents.targetUserId, ids))
            await db.delete(users).where(inArray(users.id, ids))
        }
        await listener.quit()
        redisHealth.stop()
        redisClient.disconnect(false)
        await pool.end()
    })

    it('gives the role, records a cli event and signals the running instances', async () => {
        const user = await insertUser(true)
        // feat-247 (Р10): a staff role needs a second factor while MFA_REQUIRED_FOR_STAFF is on.
        await enrollTestTotp(user.id)

        const result = await run(['--email', user.email.toUpperCase(), '--role', 'kb_editor'])

        expect(result).toMatchObject({ code: 0, errors: [] })
        expect(result.lines[0]).toContain('role user -> kb_editor')
        const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, user.id))
        expect(row?.role).toBe('kb_editor')
        const [event] = await db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.targetUserId, user.id))
        expect(event).toMatchObject({ actorKind: 'system', metadata: { source: 'cli' } })
        await vi.waitFor(() => {
            expect(received).toContainEqual(
                expect.objectContaining({ userId: String(user.id), event: 'user_role_changed' }),
            )
        })
    })

    it('refuses a staff role to an unverified account with the reason and exit code 1', async () => {
        const user = await insertUser(false)
        const before = received.length

        const result = await run(['--email', user.email, '--role', 'support_operator'])

        expect(result.code).toBe(1)
        expect(result.errors[0]).toContain('identity_unverified')
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(received).toHaveLength(before)
    })

    // feat-247 (Р10): no staff account without MFA, the CLI included.
    it('refuses a staff role to an account without a factor: mfa_not_enrolled, exit code 1', async () => {
        const user = await insertUser(true)
        const before = received.length

        const result = await run(['--email', user.email, '--role', 'admin'])

        expect(result.code).toBe(1)
        expect(result.errors[0]).toContain('mfa_not_enrolled')
        const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, user.id))
        expect(row?.role).toBe('user')
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(received).toHaveLength(before)
    })

    // feat-248 (Р10, Д11): the same TOTP-only account in both modes of MFA_STAFF_FACTOR.
    it('any gives a staff role to a TOTP-only account; passkey refuses it until a passkey', async () => {
        const anyMode = await insertUser(true)
        await enrollTestTotp(anyMode.id)
        expect((await run(['--email', anyMode.email, '--role', 'kb_editor'])).code).toBe(0)

        mfaConfig.staffFactor = 'passkey'
        try {
            const user = await insertUser(true)
            await enrollTestTotp(user.id)
            const refused = await run(['--email', user.email, '--role', 'kb_editor'])
            expect(refused.code).toBe(1)
            expect(refused.errors[0]).toContain('mfa_not_enrolled')
            const [before] = await db
                .select({ role: users.role })
                .from(users)
                .where(eq(users.id, user.id))
            expect(before?.role).toBe('user')

            await withTransaction((tx) =>
                webauthnCredentialRepository.insert(
                    {
                        userId: user.id,
                        credentialId: Buffer.from(crypto.randomUUID()),
                        publicKey: Buffer.from([1]),
                        signCount: 0n,
                        transports: null,
                        aaguid: null,
                        deviceType: 'multiDevice',
                        backedUp: true,
                        name: 'Key',
                        enrollmentId: crypto.randomUUID().replaceAll('-', ''),
                    },
                    tx,
                ),
            )
            expect((await run(['--email', user.email, '--role', 'kb_editor'])).code).toBe(0)
            const [after] = await db
                .select({ role: users.role })
                .from(users)
                .where(eq(users.id, user.id))
            expect(after?.role).toBe('kb_editor')
        } finally {
            mfaConfig.staffFactor = 'any'
        }
    })

    it('answers an unknown email with exit code 1', async () => {
        const result = await run(['--email', `nobody-${stamp}@example.test`, '--role', 'user'])
        expect(result.code).toBe(1)
        expect(result.errors[0]).toContain('No user')
    })
})
