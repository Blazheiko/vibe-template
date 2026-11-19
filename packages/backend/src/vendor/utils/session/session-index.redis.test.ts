import type { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../../test-support/redis-test-client.js'
import { readBlockedClients, waitForPostponed } from '../../../test-support/redis-postponed.js'

// feat-233 (Р2, Р4, Р7, Р14) on a real Redis with the production main-client contract: the
// session record, its index member and its meta field change together (Lua scripts with a type
// check first), lastSeenAt writes bring nothing back, and the pages of the list neither skip nor
// repeat a session, whatever dies or ties in between.

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    return { PREFIX: `test:${crypto.randomUUID()}:` }
})

const silent = vi.hoisted(() => {
    const value: Record<string, unknown> = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
    }
    value['child'] = () => value
    return value
})
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))
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

const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { stop(): void }
}
const storage = await import('./redis-session-storage.js')
const { sessionPublicId } = await import('./session-public-id.js')
const { decodeSessionCursor, encodeSessionCursor } = await import('./session-page-cursor.js')
const { SESSION_PAGE_SCAN_LIMIT } = await import('./session-index.js')
const { default: sessionConfig } = await import('#config/session.js')

const admin = createTestRedis(PREFIX)
const TOKEN = 'indexUserToken000001'
const DAY_MS = 24 * 60 * 60_000
const BASE = Date.now() - 60 * 60_000

const recordKey = (id: string, token = TOKEN) => `session:${token}:${id}`
const indexKey = (token = TOKEN) => `session_index:${token}`
const metaKey = (token = TOKEN) => `session_meta:${token}`

interface Created {
    id: string
    publicId: string
    createdAtMs: number
}

const create = async (id: string, createdAtMs = Date.now(), token = TOKEN): Promise<Created> => {
    const publicId = sessionPublicId(id)
    await storage.createSignedInSession(
        {
            id,
            data: {
                userId: '42',
                userToken: token,
                csrfToken: 'c'.repeat(43),
                device: {
                    publicId,
                    ip: '203.0.113.7',
                    userAgent: 'Mozilla/5.0',
                    method: 'password',
                    signedInAt: new Date(createdAtMs).toISOString(),
                },
            },
            createdAt: new Date(createdAtMs).toISOString(),
        },
        token,
        publicId,
        createdAtMs,
    )
    return { id, publicId, createdAtMs }
}

/** `count` sessions, the first the newest, one millisecond apart. */
const createMany = async (count: number, prefix: string, newest = BASE): Promise<Created[]> => {
    const created: Created[] = []
    for (let i = 0; i < count; i += 1) {
        created.push(await create(`${prefix}-${String(i).padStart(4, '0')}`, newest - i))
    }
    return created
}

/** Every page from the start, as public ids per page, following the cursors through the API form. */
const allPages = async (excludePublicId?: string): Promise<string[][]> => {
    const pages: string[][] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 100; guard += 1) {
        const after: ReturnType<typeof decodeSessionCursor> =
            cursor === null ? null : decodeSessionCursor(cursor)
        const page = await storage.listSessions(TOKEN, { after, excludePublicId })
        pages.push(page.sessions.map((s) => s.publicId))
        if (page.next === null) return pages
        cursor = encodeSessionCursor(page.next)
    }
    throw new Error('pages did not end')
}

/** The index order: createdAt desc, then publicId desc. */
const ordered = (sessions: readonly Created[]): string[] =>
    [...sessions]
        .sort((a, b) =>
            a.createdAtMs !== b.createdAtMs
                ? b.createdAtMs - a.createdAtMs
                : a.publicId < b.publicId
                  ? 1
                  : -1,
        )
        .map((s) => s.publicId)

const indexState = async (token = TOKEN) => ({
    members: (await admin.zrange(indexKey(token), 0, -1)).sort(),
    fields: (await admin.hkeys(metaKey(token))).sort(),
})

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
beforeEach(async () => {
    if (!hasRedis) return
    vi.restoreAllMocks()
    await cleanupTestRedis(admin)
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('session record, index and meta change together (feat-233, Р2)', () => {
    it('a sign-in writes all three; a logout removes all three', async () => {
        const s = await create('one')
        expect(await admin.exists(recordKey('one'))).toBe(1)
        expect(await admin.zscore(indexKey(), s.publicId)).toBe(String(s.createdAtMs))
        expect(JSON.parse((await admin.hget(metaKey(), s.publicId)) ?? '{}')).toEqual({
            sid: 'one',
            seen: s.createdAtMs,
        })
        const maxAge = sessionConfig.maxAgeDays * 86_400
        expect(await admin.ttl(indexKey())).toBeGreaterThan(maxAge - 10)
        expect(await admin.ttl(metaKey())).toBeGreaterThan(maxAge - 10)

        // The public id is read from the record when the caller does not pass it.
        expect(await storage.destroySession('one', TOKEN)).toBe(true)
        expect(await admin.exists(recordKey('one'), indexKey(), metaKey())).toBe(0)
        expect(await storage.destroySession('one', TOKEN)).toBe(false)
    })

    it('a record that expired leaves a member the next list drops, with its field', async () => {
        const gone = await create('gone', BASE)
        const kept = await create('kept', BASE - 1)
        await admin.del(recordKey('gone'))

        const page = await storage.listSessions(TOKEN, { after: null })
        expect(page.sessions.map((s) => s.publicId)).toEqual([kept.publicId])
        expect(await indexState()).toEqual({ members: [kept.publicId], fields: [kept.publicId] })
        expect(gone.publicId).not.toBe(kept.publicId)
    })

    it('a rotation (destroyAllSessions) removes the index of the old token; the new one starts empty', async () => {
        await createMany(3, 'rot')
        await storage.destroyAllSessions(TOKEN)
        expect(await admin.exists(indexKey(), metaKey())).toBe(0)
        expect((await storage.listSessions('rotatedToken00000001', { after: null })).sessions).toEqual(
            [],
        )
    })

    it('a sign-in drops members older than SESSION_MAX_AGE_DAYS from the index and the meta', async () => {
        const old = await create('old', Date.now() - (sessionConfig.maxAgeDays + 1) * DAY_MS)
        expect((await indexState()).members).toEqual([old.publicId])
        const fresh = await create('fresh')
        // No field without a member, no member without a field.
        expect(await indexState()).toEqual({ members: [fresh.publicId], fields: [fresh.publicId] })
    })

    it.each([
        ['index', indexKey()],
        ['meta', metaKey()],
    ])('a %s key of another type fails the sign-in before anything is written', async (_, key) => {
        await admin.set(key, 'not a collection')
        await expect(create('blocked')).rejects.toThrow(/WRONGTYPE/)
        expect(await admin.exists(recordKey('blocked'))).toBe(0)
        expect(await admin.get(key)).toBe('not a collection')
    })

    it('a delete with an index of another type fails and leaves the record whole', async () => {
        const s = await create('victim')
        await admin.del(indexKey())
        await admin.set(indexKey(), 'broken')
        await expect(storage.destroySession('victim', TOKEN, s.publicId)).rejects.toThrow(
            /WRONGTYPE/,
        )
        expect(await admin.exists(recordKey('victim'))).toBe(1)
        expect(await admin.hexists(metaKey(), s.publicId)).toBe(1)
    })

    it('a connection killed before the script answers: all of it is written or none', async () => {
        const id = await client.client('ID')
        const blockedBefore = await readBlockedClients(admin)
        await admin.call('CLIENT', 'PAUSE', '10000', 'WRITE')
        const outcome = create('killed').then(
            () => 'ok',
            (err: unknown) => err,
        )
        const reconnected = new Promise((resolve) => client.once('ready', resolve))
        try {
            await waitForPostponed(admin, id, 'eval', { blockedBefore })
            await admin.call('CLIENT', 'KILL', 'ID', String(id))
        } finally {
            await admin.call('CLIENT', 'UNPAUSE')
        }
        expect(await outcome).not.toBe('ok')
        await reconnected
        await sleep(200)

        const record = await admin.exists(recordKey('killed'))
        const { members, fields } = await indexState()
        expect(members.length).toBe(record)
        expect(fields.length).toBe(record)
    })
})

describe.skipIf(!hasRedis)('lastSeenAt (feat-233, Р4)', () => {
    it('a touch writes the time of a live session and keeps the TTL of the meta key', async () => {
        const s = await create('seen', BASE)
        await admin.expire(metaKey(), 1000)
        expect(await storage.touchSession('seen', TOKEN, BASE + 5000)).toBe(true)
        expect(JSON.parse((await admin.hget(metaKey(), s.publicId)) ?? '{}')).toEqual({
            sid: 'seen',
            seen: BASE + 5000,
        })
        expect(await admin.ttl(metaKey())).toBeLessThanOrEqual(1000)
        // An older time does not move it back.
        expect(await storage.touchSession('seen', TOKEN, BASE + 10)).toBe(true)
        expect(JSON.parse((await admin.hget(metaKey(), s.publicId)) ?? '{}').seen).toBe(BASE + 5000)
    })

    it('a touch after the session was ended brings back neither the field nor the key', async () => {
        await create('ended')
        await storage.destroySession('ended', TOKEN)
        expect(await storage.touchSession('ended', TOKEN)).toBe(false)
        expect(await admin.exists(metaKey(), indexKey(), recordKey('ended'))).toBe(0)
    })

    it('a touch after a rotation creates no index for the old token', async () => {
        await create('rotated')
        await storage.destroyAllSessions(TOKEN)
        expect(await storage.touchSession('rotated', TOKEN)).toBe(false)
        expect(await admin.exists(metaKey(), indexKey())).toBe(0)
    })

    it('a touch of a record whose field is gone writes nothing', async () => {
        const s = await create('fieldless')
        await admin.hdel(metaKey(), s.publicId)
        expect(await storage.touchSession('fieldless', TOKEN)).toBe(false)
        expect(await admin.hexists(metaKey(), s.publicId)).toBe(0)
    })
})

describe.skipIf(!hasRedis)('pages of the session list (feat-233, Р7)', () => {
    it('120 sessions: pages of 50, 50 and 20, newest first, none skipped or repeated', async () => {
        const created = await createMany(120, 'p')
        const pages = await allPages()
        expect(pages.map((p) => p.length)).toEqual([50, 50, 20])
        expect(pages.flat()).toEqual(ordered(created))
    })

    it('the current session, last in the order, is never in the pages and moves no border', async () => {
        const created = await createMany(121, 'c')
        const current = created[created.length - 1]
        const pages = await allPages(current?.publicId)
        expect(pages.map((p) => p.length)).toEqual([50, 50, 20])
        expect(pages.flat()).toEqual(ordered(created.slice(0, -1)))
    })

    it('the current session in the middle is skipped without shortening its page', async () => {
        const created = await createMany(60, 'm')
        const current = created[10]
        const pages = await allPages(current?.publicId)
        expect(pages.map((p) => p.length)).toEqual([50, 9])
        expect(pages.flat()).not.toContain(current?.publicId)
    })

    it('dead members at a page border: the next page is full, the dead are dropped', async () => {
        const created = await createMany(110, 'd')
        for (const i of [49, 50, 51]) await admin.del(recordKey(created[i]?.id ?? ''))
        const pages = await allPages()
        expect(pages.map((p) => p.length)).toEqual([50, 50, 7])
        const alive = created.filter((_, i) => ![49, 50, 51].includes(i))
        expect(pages.flat()).toEqual(ordered(alive))
        expect((await indexState()).members).toHaveLength(107)
    })

    it('sessions ended between two requests: nothing after them is skipped', async () => {
        const created = await createMany(100, 'e')
        const first = await storage.listSessions(TOKEN, { after: null })
        // One shown on page 1 and one of page 2 end meanwhile.
        await storage.destroySession(created[3]?.id, TOKEN)
        await storage.destroySession(created[60]?.id, TOKEN)
        if (first.next === null) throw new Error('expected a second page')
        const second = await storage.listSessions(TOKEN, { after: first.next })
        expect(second.next).toBeNull()
        expect(second.sessions.map((s) => s.publicId)).toEqual(
            ordered(created.slice(50).filter((_, i) => i !== 10)),
        )
    })

    it('500 dead before the live ones: the first page is empty with a cursor, the next has them', async () => {
        const dead = await createMany(SESSION_PAGE_SCAN_LIMIT, 'dead', BASE)
        const live = await createMany(20, 'live', BASE - 10_000)
        const pipeline = admin.pipeline()
        for (const s of dead) pipeline.del(recordKey(s.id))
        await pipeline.exec()

        const first = await storage.listSessions(TOKEN, { after: null })
        expect(first.sessions).toEqual([])
        expect(first.next).not.toBeNull()
        const second = await storage.listSessions(TOKEN, { after: first.next })
        expect(second.sessions.map((s) => s.publicId)).toEqual(ordered(live))
        expect(second.next).toBeNull()
    })

    it('more than 64 sessions with one createdAt: each once, in publicId desc order', async () => {
        const created: Created[] = []
        for (let i = 0; i < 70; i += 1) created.push(await create(`tie-${String(i)}`, BASE))
        const pages = await allPages()
        expect(pages.map((p) => p.length)).toEqual([50, 20])
        expect(pages.flat()).toEqual(ordered(created))
        expect(new Set(pages.flat()).size).toBe(70)
    })

    it('a tie cut by SCAN_LIMIT: the next page goes on from the middle of the group', async () => {
        const dead = await createMany(SESSION_PAGE_SCAN_LIMIT - 10, 'gone', BASE)
        const tie: Created[] = []
        for (let i = 0; i < 30; i += 1) tie.push(await create(`mid-${String(i)}`, BASE - 5000))
        const pipeline = admin.pipeline()
        for (const s of dead) pipeline.del(recordKey(s.id))
        await pipeline.exec()

        const first = await storage.listSessions(TOKEN, { after: null })
        expect(first.sessions).toHaveLength(10)
        expect(first.next?.createdAtMs).toBe(BASE - 5000)
        const second = await storage.listSessions(TOKEN, { after: first.next })
        expect([...first.sessions, ...second.sessions].map((s) => s.publicId)).toEqual(ordered(tie))
        expect(second.next).toBeNull()
    })

    it('a session past SESSION_MAX_AGE_DAYS is dead for the list and its record is deleted', async () => {
        const old = await create('aged', Date.now() - (sessionConfig.maxAgeDays + 1) * DAY_MS)
        await create('young')
        // The young sign-in dropped the old member; put it back to see the list drop it.
        await admin.zadd(indexKey(), old.createdAtMs, old.publicId)
        await admin.hset(metaKey(), old.publicId, JSON.stringify({ sid: 'aged', seen: 1 }))
        const page = await storage.listSessions(TOKEN, { after: null })
        expect(page.sessions.map((s) => s.info.id)).toEqual(['young'])
        expect(await admin.exists(recordKey('aged'))).toBe(0)
        expect(await admin.hexists(metaKey(), old.publicId)).toBe(0)
    })
})
