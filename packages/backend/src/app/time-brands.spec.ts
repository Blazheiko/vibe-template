import { describe, expect, it } from 'vitest'
import {
    ms,
    nowUnixMs,
    seconds,
    toMs,
    unixMs,
    unixSecondsOf,
    type Seconds,
    type UnixSeconds,
} from 'shared/brand'

import {
    msArg,
    secondsArg,
    setIfAbsentWithTtlMs,
    setWithTtlSeconds,
} from '#app/services/shared/redis-ttl.js'

// feat-270 (plan Р7): the compiler keeps the units of time apart where they reach Redis, and an
// instant in seconds apart from a duration in seconds. The calls behind `() =>` never run.

type SetClient = Parameters<typeof setWithTtlSeconds>[0]

describe('Redis TTL helpers take the unit of their command', () => {
    it('EX takes Seconds, PX takes Milliseconds', () => {
        const client = {} as SetClient
        const typeCases = (): unknown[] => [
            setWithTtlSeconds(client, 'k', 'v', seconds(60)),
            setIfAbsentWithTtlMs(client, 'k', 'v', ms(60_000)),
            // @ts-expect-error milliseconds do not reach an EX expiry
            setWithTtlSeconds(client, 'k', 'v', ms(60_000)),
            // @ts-expect-error seconds do not reach a PX expiry
            setIfAbsentWithTtlMs(client, 'k', 'v', seconds(60)),
            // @ts-expect-error a bare number names no unit
            setWithTtlSeconds(client, 'k', 'v', 60),
        ]
        expect(typeof typeCases).toBe('function')
    })

    it('a Lua ARGV names its unit too', () => {
        const typeCases = (): unknown[] => [
            secondsArg(seconds(1)),
            msArg(ms(1)),
            // @ts-expect-error milliseconds are not seconds
            secondsArg(ms(1)),
            // @ts-expect-error seconds are not milliseconds
            msArg(seconds(1)),
            // @ts-expect-error an instant is not a duration
            msArg(nowUnixMs()),
        ]
        expect(typeof typeCases).toBe('function')
        expect([secondsArg(seconds(2)), msArg(ms(1_500))]).toEqual(['2', '1500'])
    })
})

describe('UnixSeconds', () => {
    it('is an instant, not a duration in seconds', () => {
        const at: UnixSeconds = unixSecondsOf(unixMs(1_999))
        const typeCases = (): unknown[] => [
            // @ts-expect-error an instant is not a TTL
            ((ttl: Seconds) => ttl)(at),
            // @ts-expect-error an instant does not become a duration in milliseconds
            toMs(unixSecondsOf(nowUnixMs())),
            // @ts-expect-error a duration is not an instant
            ((instant: UnixSeconds) => instant)(seconds(60)),
        ]
        expect(typeof typeCases).toBe('function')
        expect(at).toBe(1)
    })
})
