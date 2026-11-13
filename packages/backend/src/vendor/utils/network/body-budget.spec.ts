import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-201 (security review 2026-11-12, M-3): the bytes of request bodies being buffered, in
// total and per client address, and what reading a body does with that budget.
vi.mock('#vendor/utils/logger.js', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('#config/app.js', () => ({
    default: { maxInFlightBodyBytes: 1000, maxInFlightBodyBytesPerIp: 300 },
}))

const { __resetBodyBudgetForTests, bodyBytesInFlight, chargeBodyBytes, releaseBodyBytes } =
    await import('./body-budget.js')
const { getData } = await import('./http-request-handlers.js')
const { BodyBudgetExceededError } = await import('./errors/body-budget-exceeded-error.js')
const { PayloadTooLargeError } = await import('./errors/payload-too-large-error.js')
const { classifyError } = await import('./errors/classify-error.js')

const LIMITS = { maxInFlightBodyBytes: 1000, maxInFlightBodyBytesPerIp: 300 }

beforeEach(() => {
    __resetBodyBudgetForTests()
})

describe('chargeBodyBytes', () => {
    it('charges up to the limit of the address and refuses the byte over it', () => {
        expect(chargeBodyBytes('a', 300, LIMITS)).toBe('ok')
        expect(chargeBodyBytes('a', 1, LIMITS)).toBe('ip')
        expect(bodyBytesInFlight('a')).toBe(300)
        expect(bodyBytesInFlight()).toBe(300)
    })

    it('does not count one address against another, until the total is full', () => {
        for (const ip of ['a', 'b', 'c']) expect(chargeBodyBytes(ip, 300, LIMITS)).toBe('ok')
        expect(chargeBodyBytes('d', 100, LIMITS)).toBe('ok')

        expect(chargeBodyBytes('e', 1, LIMITS)).toBe('global')
        expect(bodyBytesInFlight('e')).toBe(0)
        expect(bodyBytesInFlight()).toBe(1000)
    })

    it('a refusal charges nothing', () => {
        chargeBodyBytes('a', 200, LIMITS)

        expect(chargeBodyBytes('a', 200, LIMITS)).toBe('ip')
        expect(bodyBytesInFlight('a')).toBe(200)
        expect(chargeBodyBytes('a', 100, LIMITS)).toBe('ok')
    })

    it('gives the bytes back and forgets an address with nothing in flight', () => {
        chargeBodyBytes('a', 300, LIMITS)
        releaseBodyBytes('a', 300)
        // Releasing more than was charged must not go below zero.
        releaseBodyBytes('a', 300)

        expect(bodyBytesInFlight('a')).toBe(0)
        expect(bodyBytesInFlight()).toBe(0)
        expect(chargeBodyBytes('a', 300, LIMITS)).toBe('ok')
    })

    it('0 switches a limit off', () => {
        const off = { maxInFlightBodyBytes: 0, maxInFlightBodyBytesPerIp: 0 }
        expect(chargeBodyBytes('a', 10_000_000, off)).toBe('ok')
        expect(chargeBodyBytes('a', 10_000_000, off)).toBe('ok')
    })
})

/** A uWS response whose body the test feeds chunk by chunk. */
const upload = (ipKey: string, limit = 10_000) => {
    let onData: (chunk: ArrayBuffer, isLast: boolean) => void = () => undefined
    const abortSignal: { aborted: boolean; onAbort?: () => void } = { aborted: false }
    const res = {
        onData: (cb: typeof onData) => {
            onData = cb
            return res
        },
    }
    const outcome = getData(
        res as never,
        'application/json',
        new Map(),
        limit,
        abortSignal,
        ipKey,
    ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
    )
    const send = (bytes: number, isLast = false): void => {
        // A whole body sent as one last chunk is a JSON object of exactly `bytes` bytes.
        const text = isLast ? `{"s":"${'a'.repeat(Math.max(0, bytes - 8))}"}` : 'a'.repeat(bytes)
        const chunk = new TextEncoder().encode(text)
        onData(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength), isLast)
    }
    return {
        outcome,
        send,
        abort: () => {
            abortSignal.aborted = true
            abortSignal.onAbort?.()
        },
    }
}

describe('reading a body charges the in-flight budget', () => {
    it('holds the bytes while the body is incomplete and gives them back when it is read', async () => {
        const first = upload('a')
        first.send(100)
        first.send(100)
        expect(bodyBytesInFlight('a')).toBe(200)

        const done = upload('b')
        done.send(50, true)
        expect((await done.outcome).ok).toBe(true)
        expect(bodyBytesInFlight('b')).toBe(0)
        expect(bodyBytesInFlight()).toBe(200)
    })

    it('answers 429 to the body that takes the address over its limit, and frees what it held', async () => {
        const stalled = upload('a')
        stalled.send(250)
        const next = upload('a')
        next.send(40)

        next.send(20)

        const result = await next.outcome
        expect(result.ok).toBe(false)
        const error = (result as { error: unknown }).error
        expect(error).toBeInstanceOf(BodyBudgetExceededError)
        expect(classifyError(error)).toMatchObject({
            status: 429,
            code: 'rate_limited',
            headers: { 'Retry-After': '1' },
            closeConnection: true,
            log: { level: 'warn' },
        })
        // The refused upload gave its 40 bytes back; the stalled one still holds its own.
        expect(bodyBytesInFlight('a')).toBe(250)
        // Chunks that still arrive for the refused request are ignored.
        next.send(10)
        expect(bodyBytesInFlight('a')).toBe(250)
    })

    it('answers 503 when the total is full, whoever sends', async () => {
        for (const ip of ['a', 'b', 'c']) upload(ip).send(300)
        const last = upload('d')
        last.send(100)

        const victim = upload('e')
        victim.send(1)

        const error = ((await victim.outcome) as { error: unknown }).error
        expect(classifyError(error)).toMatchObject({
            status: 503,
            code: 'service_unavailable',
            closeConnection: true,
            log: { level: 'warn' },
        })
    })

    it('gives the bytes back when the client goes away', async () => {
        const stalled = upload('a')
        stalled.send(250)

        stalled.abort()

        expect((await stalled.outcome).ok).toBe(false)
        expect(bodyBytesInFlight('a')).toBe(0)
        expect(bodyBytesInFlight()).toBe(0)
        // The address can upload again.
        const next = upload('a')
        next.send(250)
        expect(bodyBytesInFlight('a')).toBe(250)
    })

    it('gives the bytes back when the body is over the size limit of the route', async () => {
        const tooLarge = upload('a', 150)
        tooLarge.send(100)
        expect(bodyBytesInFlight('a')).toBe(100)

        tooLarge.send(100)

        const error = ((await tooLarge.outcome) as { error: unknown }).error
        expect(error).toBeInstanceOf(PayloadTooLargeError)
        expect(bodyBytesInFlight('a')).toBe(0)
    })

    it('gives the bytes back once: a late abort after the body was read changes nothing', async () => {
        const other = upload('a')
        other.send(100)
        const done = upload('a')
        done.send(50, true)
        await done.outcome

        done.abort()

        expect(bodyBytesInFlight('a')).toBe(100)
    })
})
