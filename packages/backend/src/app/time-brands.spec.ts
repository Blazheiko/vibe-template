import { describe, expect, it } from 'vitest'
import {
    addMs,
    diffMs,
    ms,
    nowUnixMs,
    seconds,
    toMs,
    toSecondsCeil,
    toSecondsFloor,
    unixMs,
    unixSecondsOf,
    type Milliseconds,
    type Seconds,
    type UnixMs,
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

// feat-271 (plan Р7, T38): the three units and the operations that keep them apart.
describe('units of time and their operations', () => {
    it('a bare number names no unit, and the units do not stand for each other', () => {
        const typeCases = (): unknown[] => [
            // @ts-expect-error a bare number is no duration
            ((d: Milliseconds) => d)(1_000),
            // @ts-expect-error seconds are not milliseconds
            ((d: Milliseconds) => d)(seconds(1)),
            // @ts-expect-error milliseconds are not seconds
            ((d: Seconds) => d)(ms(1_000)),
            // @ts-expect-error a duration is not an instant
            ((at: UnixMs) => at)(ms(1_000)),
            // @ts-expect-error an instant is not a duration
            ((d: Milliseconds) => d)(nowUnixMs()),
        ]
        expect(typeof typeCases).toBe('function')
    })

    it('addMs / diffMs / toMs / toSeconds* take and give the right units', () => {
        const at = unixMs(10_000)
        const later: UnixMs = addMs(at, ms(1_500))
        const gap: Milliseconds = diffMs(later, at)
        const typeCases = (): unknown[] => [
            // @ts-expect-error an instant plus seconds: the delta must be milliseconds
            addMs(at, seconds(1)),
            // @ts-expect-error two durations: addMs moves an instant
            addMs(ms(1), ms(1)),
            // @ts-expect-error diffMs compares two instants
            diffMs(ms(2), ms(1)),
            // @ts-expect-error toMs takes seconds
            toMs(ms(1)),
            // @ts-expect-error toSecondsCeil takes milliseconds
            toSecondsCeil(seconds(1)),
            // @ts-expect-error toSecondsFloor takes milliseconds
            toSecondsFloor(seconds(1)),
            // @ts-expect-error the sum of two brands is a bare number
            ((d: Milliseconds) => d)(ms(1) + ms(1)),
        ]
        expect(typeof typeCases).toBe('function')
        expect([later, gap]).toEqual([11_500, 1_500])
        const up: Seconds = toSecondsCeil(gap)
        const down: Seconds = toSecondsFloor(gap)
        const back: Milliseconds = toMs(up)
        expect([up, down, back]).toEqual([2, 1, 2_000])
    })
})
