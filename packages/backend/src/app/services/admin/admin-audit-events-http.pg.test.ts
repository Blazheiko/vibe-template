import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'

import { eq, inArray } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { enrollTestTotp, type TestTotp } from '../../../test-support/test-totp.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'
import { testAdminActor } from '../../../test-support/audit-actor.js'
import { isStaffRole, type Role } from 'shared/access'
import type { SupportArticleId, UserId } from '#app/domain/ids.js'

// feat-235 T6 and T6a: GET /admin/audit-events over HTTP with the real route table, session_web,
// csrf_guard, auth_guard and admin_guard, against a real PostgreSQL and Redis: who may read the
// log, every filter, the cursor over events with one occurred_at, and the history of one object
// in the order its changes were applied (two edits of a prompt and of an article that raced for
// the row lock). Only per-IP limits, the auth throttle, notifications and indexing are replaced.

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

const PORT = await getFreePort()
const ORIGIN = `http://localhost:${String(PORT)}`

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['CSRF_ENFORCE'] = 'true'
    process.env['CSRF_STRICT_ORIGIN'] = 'true'
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
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))
vi.mock('#app/services/support/support-embedding-service.js', () => ({
    supportEmbeddingService: {
        indexArticle: () => Promise.resolve(true),
        reindexAll: () => Promise.resolve({ indexed: 0, failed: [] }),
    },
}))

const PASSWORD = 'audit-http-secret-123'

describe.skipIf(!hasPg || !hasRedis)('GET /admin/audit-events (feat-235)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { auditEvents, llmSystemPrompts, supportKnowledgeBase, users } =
        await import('#database/schema.js')
    const { default: redisClient, redisHealth } =
        (await import('#database/redis.js')) as unknown as {
            default: Redis
            redisHealth: { stop(): void }
        }
    const { hashPassword } = await import('metautil')
    const { default: sessionConfig } = await import('#config/session.js')
    const { auditEventsRepository, promptRepository, supportKnowledgeRepository } =
        await import('#app/repositories/index.js')
    const { promptService } = await import('#app/services/ai/prompt-service.js')
    const { knowledgeBaseService } = await import('#app/services/support/knowledge-base-service.js')

    await import('#app/start/index.js')

    const redisAdmin = createTestRedis(PREFIX)
    const now = Date.now()
    const run = `http-${String(now)}`
    const createdUserIds: UserId[] = []
    const articleIds: SupportArticleId[] = []
    let stopServer: ((type?: string) => Promise<void>) | undefined
    let insertedPrompt = false
    let inserted = 0

    const insertUser = async (role: Role, name = 'audit-reader') => {
        inserted += 1
        const [row] = await db
            .insert(users)
            .values({
                name,
                email: `audit-${String(now)}-${String(inserted)}@example.test`,
                password: await hashPassword(PASSWORD),
                emailVerifiedAt: new Date(),
                role,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    interface Reply {
        status: number
        body: Record<string, unknown>
    }

    class Browser {
        cookie: string | undefined
        csrf: string | undefined
        /** Other cookies, such as the second-step ticket of a sign-in with MFA (feat-247). */
        others = new Map<string, string>()

        async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
            const headers: Record<string, string> = { origin: ORIGIN }
            const cookies = [...this.others].map(([name, value]) => `${name}=${value}`)
            if (this.cookie !== undefined)
                cookies.push(`${sessionConfig.cookieName}=${this.cookie}`)
            if (cookies.length > 0) headers['cookie'] = cookies.join('; ')
            if (this.csrf !== undefined) headers['x-csrf-token'] = this.csrf
            if (body !== undefined) headers['content-type'] = 'application/json'
            const response = await fetch(`http://127.0.0.1:${String(PORT)}/api${path}`, {
                method,
                headers,
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            })
            const text = await response.text()
            const parsed = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>
            for (const line of response.headers.getSetCookie()) {
                const [pair = ''] = line.split(';')
                const name = pair.slice(0, pair.indexOf('='))
                if (name === sessionConfig.cookieName) continue
                const value = pair.slice(pair.indexOf('=') + 1)
                if (value === '') this.others.delete(name)
                else this.others.set(name, value)
            }
            const setCookie = response.headers
                .getSetCookie()
                .find((value) => value.startsWith(`${sessionConfig.cookieName}=`))
            if (setCookie !== undefined) {
                this.cookie = setCookie.slice(
                    sessionConfig.cookieName.length + 1,
                    setCookie.indexOf(';'),
                )
            }
            if (typeof parsed['csrfToken'] === 'string') this.csrf = parsed['csrfToken']
            return { status: response.status, body: parsed }
        }

        /** Signs in; with `totp`, answers the second step (a staff account has MFA, feat-247). */
        async signIn(email: string, totp?: TestTotp): Promise<void> {
            await this.request('GET', '/main/init')
            const reply = await this.request('POST', '/auth/login', {
                identifier: email,
                password: PASSWORD,
            })
            expect(reply.status).toBe(200)
            if (reply.body['status'] !== 'mfa_required') return
            if (totp === undefined) throw new Error('the account asks for a second factor')
            const verified = await this.request('POST', '/auth/mfa/verify', {
                method: 'totp',
                code: totp.code(),
            })
            expect(verified.status).toBe(200)
        }

        list(query: string): Promise<Reply> {
            return this.request('GET', `/admin/audit-events${query === '' ? '' : `?${query}`}`)
        }
    }

    type Item = Record<string, unknown> & {
        id: string
        action: string
        occurredAt: string
        actor: Record<string, unknown>
        targetUser: Record<string, unknown> | null
        changes: Record<string, unknown> | null
    }
    const itemsOf = (reply: Reply): Item[] => reply.body['items'] as Item[]

    const signedIn = async (role: Role, name?: string) => {
        const user = await insertUser(role, name)
        // feat-247 (Р10): a staff role uses its permissions with a second factor (on by default).
        const totp = isStaffRole(role) ? await enrollTestTotp(user.id) : undefined
        const browser = new Browser()
        await browser.signIn(user.email ?? '', totp)
        return { user, browser }
    }

    /** Events written straight to the table, with one namespace per run so filters see only them. */
    const insertEvents = async (
        rows: {
            occurredAt: string
            action?: string
            targetType?: string
            targetId?: string
            actorUserId?: UserId | null
            targetUserId?: UserId | null
            requestId?: string | null
        }[],
    ): Promise<void> => {
        await auditEventsRepository.insert(
            rows.map((row) => ({
                occurredAt: row.occurredAt,
                actorKind: row.actorUserId == null ? ('system' as const) : ('user' as const),
                actorUserId: row.actorUserId ?? null,
                actorRole: null,
                action: row.action ?? 'auth.sessions.revoked_all',
                targetType: row.targetType ?? 'user',
                targetId: row.targetId ?? `${run}-target`,
                targetUserId: row.targetUserId ?? null,
                requestId: row.requestId ?? null,
                changes: null,
                metadata: row.actorUserId == null ? { source: 'seed' } : null,
            })),
            db,
        )
    }

    beforeAll(async () => {
        await redisAdmin.connect()
        await redisClient.connect()
        const { routesHandler, createWsRoutesByUrl } = await import('#vendor/start/router.js')
        const { default: httpRoutes } = await import('#app/routes/http-routes.js')
        const { default: wsRoutes } = await import('#app/routes/ws-routes.js')
        const server = await import('#vendor/start/server.js')
        stopServer = server.stopServer
        await server.initServer({
            httpRoutes: routesHandler(httpRoutes),
            wsRoutesByUrl: createWsRoutesByUrl(routesHandler(wsRoutes)),
            sourceHttpRoutes: httpRoutes,
            sourceWsRoutes: wsRoutes,
        })
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        await stopServer?.('test')
        await db
            .delete(auditEvents)
            .where(
                inArray(auditEvents.targetId, [`${run}-target`, `${run}-filters`, `${run}-scope`]),
            )
        for (const id of createdUserIds) {
            await db.delete(auditEvents).where(eq(auditEvents.targetUserId, id))
            await db.delete(auditEvents).where(eq(auditEvents.actorUserId, id))
            await db.delete(users).where(eq(users.id, id))
        }
        if (articleIds.length > 0) {
            await db
                .delete(auditEvents)
                .where(inArray(auditEvents.targetId, articleIds.map(String)))
            await db
                .delete(supportKnowledgeBase)
                .where(inArray(supportKnowledgeBase.id, articleIds))
        }
        await db.delete(auditEvents).where(eq(auditEvents.targetId, 'SUPPORT_FIRST_CHAT'))
        if (insertedPrompt) {
            await db.delete(llmSystemPrompts).where(eq(llmSystemPrompts.type, 'SUPPORT_FIRST_CHAT'))
        }
        await cleanupTestRedis(redisAdmin)
        redisHealth.stop()
        redisClient.disconnect(false)
        await redisAdmin.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    it('answers 401 without a session and 403 to a user who is not an admin', async () => {
        const anonymous = new Browser()
        await anonymous.request('GET', '/main/init')
        expect((await anonymous.list('')).status).toBe(401)

        const { browser } = await signedIn('user')
        const reply = await browser.list('')
        expect(reply.status).toBe(403)
        expect(reply.body['items']).toBeUndefined()
    })

    it('pages through events of one stamp without losing or repeating one', async () => {
        const { browser } = await signedIn('admin')
        const target = `${run}-target`
        await insertEvents(
            Array.from({ length: 53 }, () => ({ occurredAt: '2026-11-20 10:00:00.000001' })),
        )
        await insertEvents([{ occurredAt: '2026-11-20 10:00:00.000002' }])

        const first = await browser.list(`targetType=user&targetId=${target}`)
        expect(first.status).toBe(200)
        const firstItems = itemsOf(first)
        expect(firstItems).toHaveLength(50)
        expect(firstItems[0]?.occurredAt).toBe('2026-11-20T10:00:00.000002Z')
        const cursor = first.body['nextCursor']
        expect(typeof cursor).toBe('string')

        const second = await browser.list(
            `targetType=user&targetId=${target}&cursor=${String(cursor)}`,
        )
        const secondItems = itemsOf(second)
        expect(secondItems).toHaveLength(4)
        expect(second.body['nextCursor']).toBeNull()
        const ids = [...firstItems, ...secondItems].map((item) => BigInt(item.id))
        expect(new Set(ids).size).toBe(54)
        // Newest first, then by id: the ids of one stamp come down.
        const sameStamp = ids.slice(1)
        expect(sameStamp).toEqual([...sameStamp].sort((a, b) => (a > b ? -1 : 1)))
    })

    it('filters by action, group, actor, target user, target, request id and time', async () => {
        const { browser } = await signedIn('admin')
        const actor = await insertUser('admin', 'Actor Admin')
        const subject = await insertUser('user', 'Subject User')
        const requestId = randomUUID()
        const target = `${run}-filters`
        await insertEvents([
            {
                occurredAt: '2026-10-01 00:00:00.000500',
                targetId: target,
                action: 'auth.password.changed',
                actorUserId: subject.id,
                targetUserId: subject.id,
                requestId,
            },
            {
                occurredAt: '2026-10-01 00:00:01',
                targetId: target,
                action: 'auth.sessions.revoked_others',
                actorUserId: actor.id,
                targetUserId: subject.id,
            },
            {
                occurredAt: '2026-10-01 00:00:02',
                targetId: target,
                action: 'kb.article.updated',
                targetType: 'kb_article',
                actorUserId: actor.id,
            },
        ])
        const actions = async (query: string): Promise<string[]> => {
            const reply = await browser.list(`${query}&targetId=${target}`)
            expect(reply.status, query).toBe(200)
            return itemsOf(reply).map((item) => item.action)
        }

        expect(await actions('action=auth.password.changed&action=kb.article.updated')).toEqual([
            'kb.article.updated',
            'auth.password.changed',
        ])
        expect(await actions('group=sessions')).toEqual(['auth.sessions.revoked_others'])
        expect(await actions('group=kb&action=auth.password.changed')).toEqual([])
        expect(await actions(`actorUserId=${String(actor.id)}`)).toEqual([
            'kb.article.updated',
            'auth.sessions.revoked_others',
        ])
        expect(await actions(`targetUserId=${String(subject.id)}&group=sign-in`)).toEqual([
            'auth.password.changed',
        ])
        expect(await actions('targetType=kb_article')).toEqual(['kb.article.updated'])
        expect(await actions(`requestId=${requestId}`)).toEqual(['auth.password.changed'])
        // `from` is inclusive of its whole millisecond, `to` exclusive of its own.
        expect(await actions('from=2026-10-01T00:00:00.000Z&to=2026-10-01T00:00:01.000Z')).toEqual([
            'auth.password.changed',
        ])
        expect(await actions('from=2026-10-01T00:00:01.000Z')).toEqual([
            'kb.article.updated',
            'auth.sessions.revoked_others',
        ])

        // The actor and the account it concerns carry names; an account deleted since, its id.
        const [revoked] = itemsOf(
            await browser.list(`action=auth.sessions.revoked_others&targetId=${target}`),
        )
        expect(revoked?.actor).toMatchObject({
            kind: 'user',
            userId: String(actor.id),
            name: 'Actor Admin',
            deleted: false,
        })
        expect(revoked?.targetUser).toEqual({
            id: String(subject.id),
            name: 'Subject User',
            deleted: false,
        })
        expect(JSON.stringify(revoked)).not.toContain('@example.test')
        await db.delete(users).where(eq(users.id, subject.id))
        const [afterDelete] = itemsOf(
            await browser.list(`action=auth.sessions.revoked_others&targetId=${target}`),
        )
        expect(afterDelete?.targetUser).toEqual({
            id: String(subject.id),
            name: null,
            deleted: true,
        })
    })

    it('refuses an invalid cursor, time, action, id or an unknown key, never with a 500', async () => {
        const { browser } = await signedIn('admin')
        const cursorOf = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

        // What the query schema accepts by shape but PostgreSQL could not take: 400 from the
        // service, before any query.
        for (const query of [
            `cursor=${cursorOf('not a cursor')}`,
            `cursor=${cursorOf('2026-13-45 99:00:00|1')}`,
            // February 30th: Date.parse rolls it over to March 2nd.
            `cursor=${cursorOf('2026-02-30 10:00:00|1')}`,
            `cursor=${cursorOf('2026-11-20 10:00:00|9223372036854775808')}`,
            `cursor=${cursorOf('2026-11-20 10:00:00|0')}`,
            `cursor=${cursorOf('2026-11-20 10:00:00|007')}`,
            'from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z',
        ]) {
            const reply = await browser.list(query)
            expect(reply.status, query).toBe(400)
            expect(reply.body['items'], query).toBeUndefined()
        }
        // What the query schema refuses by shape: the framework's 422.
        for (const query of [
            'cursor=has%20space',
            'from=yesterday',
            'to=2026-13-01',
            'action=kb.article.unknown',
            'group=nope',
            'actorUserId=abc',
            // feat-262: an id past bigint, zero or a leading zero is refused by the schema.
            'actorUserId=9223372036854775808',
            'targetUserId=99999999999999999999',
            'actorUserId=0',
            'targetUserId=007',
            'unknown=1',
        ]) {
            const reply = await browser.list(query)
            expect(reply.status, query).toBe(422)
            expect(reply.body['items'], query).toBeUndefined()
        }
        // The largest id PostgreSQL holds is a valid filter.
        expect((await browser.list('actorUserId=9223372036854775807')).status).toBe(200)
    })

    // T6a (Р7, Р13): the history of one object reads in the order its changes were applied.
    describe('the order of an object history', () => {
        /** The first edit's transaction opens first, but it gets the row lock second. */
        const raceLocks = <T extends object>(repository: T, method: keyof T & string): void => {
            const original = (repository[method] as (...args: unknown[]) => Promise<unknown>).bind(
                repository,
            )
            let secondLocked: () => void = () => undefined
            const secondHasLock = new Promise<void>((resolve) => {
                secondLocked = resolve
            })
            let calls = 0
            vi.spyOn(repository, method as never).mockImplementation((async (
                ...args: unknown[]
            ) => {
                calls += 1
                if (calls === 1) {
                    await secondHasLock
                    return original(...args)
                }
                const row = await original(...args)
                secondLocked()
                await new Promise((resolve) => setTimeout(resolve, 50))
                return row
            }) as never)
        }
        const historyOf = async (browser: Browser, targetType: string, targetId: string) => {
            const reply = await browser.list(`targetType=${targetType}&targetId=${targetId}`)
            expect(reply.status).toBe(200)
            return itemsOf(reply)
        }

        it('of two edits of a prompt, the one applied last is first, its before the other after', async () => {
            const { browser } = await signedIn('admin')
            const type = 'SUPPORT_FIRST_CHAT' as const
            if ((await promptRepository.findByType(type)) === undefined) {
                await db.insert(llmSystemPrompts).values({ type, content: 'x', model: 'start' })
                insertedPrompt = true
            }
            await db
                .update(llmSystemPrompts)
                .set({ model: 'start' })
                .where(eq(llmSystemPrompts.type, type))
            await db.delete(auditEvents).where(eq(auditEvents.targetId, type))
            raceLocks(promptRepository, 'lockByType')

            const first = promptService.update(type, { model: 'first' }, testAdminActor())
            await new Promise((resolve) => setTimeout(resolve, 10))
            const second = promptService.update(type, { model: 'second' }, testAdminActor())
            await Promise.all([first, second])

            const history = await historyOf(browser, 'llm_prompt', type)
            expect(history.map((item) => item.changes)).toEqual([
                { model: { from: 'second', to: 'first' } },
                { model: { from: 'start', to: 'second' } },
            ])
        })

        it('of two edits of an article, the one applied last is first', async () => {
            const { browser } = await signedIn('admin')
            const row = await supportKnowledgeRepository.create({ title: 'start', content: 'c' })
            articleIds.push(row.id)
            raceLocks(supportKnowledgeRepository, 'lockById')

            const first = knowledgeBaseService.update(row.id, { title: 'first' }, testAdminActor())
            await new Promise((resolve) => setTimeout(resolve, 10))
            const second = knowledgeBaseService.update(
                row.id,
                { title: 'second' },
                testAdminActor(),
            )
            await Promise.all([first, second])

            const history = await historyOf(browser, 'kb_article', String(row.id))
            expect(history.map((item) => item.changes)).toEqual([
                { title: { from: 'second', to: 'first' } },
                { title: { from: 'start', to: 'second' } },
            ])
        })
    })

    // feat-240 (Р5): a reader with audit.read.account only (support_operator) sees the sign-in and
    // session events of user accounts; every explicit filter outside them is a 403.
    describe('the account scope (feat-240)', () => {
        it.each([
            ['a group outside it', 'group=kb'],
            [
                'a forbidden action next to an allowed group',
                'group=sign-in&action=kb.article.updated',
            ],
            [
                'one forbidden action among allowed ones',
                'action=auth.password.changed&action=ai.prompt.updated',
            ],
            ['a target type other than user', 'targetType=kb_article'],
        ])('answers 403 to an operator for %s', async (_name, query) => {
            const { browser } = await signedIn('support_operator', 'operator')
            const reply = await browser.list(query)
            expect(reply.status).toBe(403)
            expect(reply.body).toMatchObject({ status: 'error', code: 'forbidden' })
        })

        it('gives an operator full pages of account events only, over mixed groups', async () => {
            const scope = `${run}-scope`
            // 60 session events and 60 knowledge-base events, interleaved in time.
            await insertEvents(
                Array.from({ length: 120 }, (_, index) => {
                    const second = String(index).padStart(3, '0')
                    const at = `2026-09-01 00:00:00.000${second}`
                    return index % 2 === 0
                        ? { occurredAt: at, targetId: scope }
                        : {
                              occurredAt: at,
                              targetId: scope,
                              action: 'kb.article.updated',
                              targetType: 'kb_article',
                          }
                }),
            )
            const { browser } = await signedIn('support_operator', 'operator')

            const first = await browser.list(`targetId=${scope}`)
            expect(first.status).toBe(200)
            expect(itemsOf(first)).toHaveLength(50)
            const cursor = first.body['nextCursor']
            expect(typeof cursor).toBe('string')
            const second = await browser.list(`targetId=${scope}&cursor=${String(cursor)}`)
            expect(itemsOf(second)).toHaveLength(10)
            expect(second.body['nextCursor']).toBeNull()
            for (const item of [...itemsOf(first), ...itemsOf(second)]) {
                expect(item.action).toBe('auth.sessions.revoked_all')
            }

            // Without any filter: every row is a sign-in or session event.
            const all = await browser.list('')
            expect(all.status).toBe(200)
            for (const item of itemsOf(all)) {
                expect(item.action).toMatch(/^auth\./)
            }

            // An admin, with audit.read, sees both groups.
            const { browser: admin } = await signedIn('admin', 'admin-reader')
            const mixed = await admin.list(`targetId=${scope}`)
            expect(new Set(itemsOf(mixed).map((item) => item.action))).toEqual(
                new Set(['auth.sessions.revoked_all', 'kb.article.updated']),
            )
        })

        it('lets a kb_editor not read the log at all', async () => {
            const { browser } = await signedIn('kb_editor', 'editor')
            expect((await browser.list('')).status).toBe(403)
        })
    })
})
