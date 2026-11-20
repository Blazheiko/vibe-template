// Benchmark of the response contract check (feat-046 §4.7): JSON.stringify against the
// feat-044 check (the bare schema) and createResponseCheck itself — a clean response, and
// the whole path of a response with undeclared keys in log mode (reject → inspect → strip
// → log). Medians of 7 runs after a warm-up. Run with LOG_LEVEL=silent.
import { type } from '@arktype/type'
import { createResponseCheck } from '#vendor/utils/validation/validate-response.js'
import { makeBroadcastJson } from '#vendor/utils/helpers/json-handlers.js'
import { BroadcastEventSchemas } from 'shared/schemas'

const ErrorSchema = type({
    status: "'error'",
    code: "'bad_request' | 'not_found' | 'internal_error'",
    message: 'string',
    'reason?': 'string',
    'details?': 'unknown',
})
const ItemSchema = type({
    id: 'string',
    userId: 'string',
    endpoint: 'string',
    userAgent: 'string | null',
    isActive: 'boolean',
    lastUsedAt: 'Date | null',
    createdAt: 'Date',
})
const Schema = type.or(
    { status: "'success'", 'message?': 'string', items: ItemSchema.array(), total: 'number' },
    ErrorSchema,
)
const strictCheck = createResponseCheck(Schema, { mode: 'strict' })
const logCheck = createResponseCheck(Schema, { mode: 'log' })
if (strictCheck === null || logCheck === null) throw new Error('no check')
const meta = { route: 'bench', transport: 'http' as const }

const makePayload = (count: number, withExtraKey: boolean): unknown => ({
    status: 'success',
    total: count,
    items: Array.from({ length: count }, (_, i) => ({
        id: `id${String(i)}`,
        userId: `u${String(i)}`,
        endpoint: `https://push.example/${String(i)}`,
        userAgent: 'Mozilla/5.0',
        isActive: true,
        lastUsedAt: new Date(),
        createdAt: new Date(),
        ...(withExtraKey ? { passwordHash: 'x' } : {}),
    })),
})

const median = (
    fn: (payload: unknown) => unknown,
    payload: unknown,
    iterations: number,
): number => {
    for (let i = 0; i < 200; i++) fn(payload)
    const runs: number[] = []
    for (let run = 0; run < 7; run++) {
        const start = process.hrtime.bigint()
        for (let i = 0; i < iterations; i++) fn(payload)
        runs.push(Number(process.hrtime.bigint() - start) / iterations / 1e6)
    }
    runs.sort((a, b) => a - b)
    return runs[3] ?? 0
}

const rows = [10, 100, 1000].map((count) => {
    const iterations = count === 1000 ? 300 : 3000
    const clean = makePayload(count, false)
    const dirty = makePayload(count, true)
    const json = median((payload) => JSON.stringify(payload), clean, iterations)
    const check = median((payload) => Schema(payload), clean, iterations)
    const rejectMs = median((payload) => strictCheck(payload, meta), clean, iterations)
    const dirtyMs = median((payload) => logCheck(payload, meta), dirty, iterations)
    return {
        items: count,
        'json ms': json.toFixed(4),
        'feat-044 check ms': check.toFixed(4),
        'clean ms': rejectMs.toFixed(4),
        'clean / json': (rejectMs / json).toFixed(2),
        'clean / check': (rejectMs / check).toFixed(2),
        'undeclared path ms': dirtyMs.toFixed(4),
        'undeclared / json': (dirtyMs / json).toFixed(1),
    }
})

console.table(rows)

// Broadcast events (feat-049 §4.3): one check per event before serialization, against
// building the broadcast JSON for it.
const events = [
    ['support_chat_token', { token: 'Hello, ' }],
    [
        'admin_user_online_upsert',
        {
            id: '42',
            name: 'Ada',
            email: 'ada@example.test',
            appType: 'web',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            connectionsCount: 2,
        },
    ],
] as const
console.table(
    events.map(([event, payload]) => {
        const eventCheck = createResponseCheck(BroadcastEventSchemas[event], { mode: 'log' })
        if (eventCheck === null) throw new Error('no check')
        const eventMeta = { route: event, transport: 'broadcast' as const }
        const json = median((value) => makeBroadcastJson(event, 200, value), payload, 100_000)
        const checkMs = median((value) => eventCheck(value, eventMeta), payload, 100_000)
        return {
            event,
            'json µs': (json * 1000).toFixed(3),
            'check µs': (checkMs * 1000).toFixed(3),
            'check / json': (checkMs / json).toFixed(2),
        }
    }),
)
