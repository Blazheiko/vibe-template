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
    getAndRenewTtlSeconds,
    msArg,
    secondsArg,
    setIfAbsentWithTtlMs,
    setIfAbsentWithTtlSeconds,
    setWithTtlSeconds,
} from '#vendor/utils/redis/redis-ttl.js'
import type { storedSessionTtl as StoredSessionTtl } from '#vendor/utils/session/session-ttl.js'
import type { adminChannelSubscribers as Subscribers } from '#app/services/admin/admin-channel-subscribers.js'
import {
    NO_STAFF_DEADLINE,
    type staffSessionDeadline as StaffSessionDeadline,
} from '#app/services/auth/mfa/staff-policy.js'
import type { MyWebSocket } from '#vendor/types/types.js'
import { isActiveRecovery, isFresh, sessionAuthOf } from 'shared/mfa'

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

// feat-272: the session layer keeps its TTL in Seconds up to the Redis call.
describe('the session TTL reaches Redis as Seconds', () => {
    it('storedSessionTtl is Seconds, and only an EX helper takes it', () => {
        const client = {} as SetClient & Parameters<typeof getAndRenewTtlSeconds>[0]
        const ttl = (() => seconds(60)) as typeof StoredSessionTtl
        const typeCases = (): unknown[] => [
            setWithTtlSeconds(client, 'k', 'v', ttl('anon_session')),
            setIfAbsentWithTtlSeconds(client, 'k', 'v', ttl('token')),
            getAndRenewTtlSeconds(client, 'k', ttl('token')),
            secondsArg(ttl('token')),
            // @ts-expect-error a session TTL in seconds does not reach a PX expiry
            setIfAbsentWithTtlMs(client, 'k', 'v', ttl('token')),
            // @ts-expect-error nor a Lua ARGV in milliseconds
            msArg(ttl('token')),
            // @ts-expect-error milliseconds do not renew an EX expiry
            getAndRenewTtlSeconds(client, 'k', ms(60_000)),
            // @ts-expect-error milliseconds do not reach SET … EX … NX
            setIfAbsentWithTtlSeconds(client, 'k', 'v', ms(60_000)),
        ]
        expect(typeof typeCases).toBe('function')
    })
})

// feat-272: the staff deadline of the admin WS channel is an instant from the policy to the
// pre-publish check.
describe('the admin channel deadline is UnixMs', () => {
    it('only an instant in ms reaches the registry and its check', () => {
        const subscribers = {} as typeof Subscribers
        const deadlineOf = (() => null) as typeof StaffSessionDeadline
        const ws = {} as MyWebSocket
        const deadline = deadlineOf(undefined)
        const typeCases = (): unknown[] => [
            () => {
                if (deadline !== null) subscribers.set(ws, deadline)
            },
            subscribers.dropExpired(nowUnixMs()),
            () => {
                subscribers.set(ws, NO_STAFF_DEADLINE)
            },
            // feat-273: never is no instant; arithmetic needs the narrowing first.
            deadline === null || deadline === NO_STAFF_DEADLINE ? 0 : diffMs(deadline, nowUnixMs()),
            // @ts-expect-error a deadline that may be never is not an instant
            deadline === null ? 0 : diffMs(deadline, nowUnixMs()),
            // @ts-expect-error never is not an instant
            diffMs(NO_STAFF_DEADLINE, nowUnixMs()),
            () => {
                // @ts-expect-error a duration is not a deadline
                subscribers.set(ws, ms(60_000))
            },
            () => {
                // @ts-expect-error an instant in seconds is not one in milliseconds
                subscribers.set(ws, unixSecondsOf(nowUnixMs()))
            },
            // @ts-expect-error a bare number names no unit
            subscribers.dropExpired(Date.now()),
            // @ts-expect-error a duration is not the current instant
            subscribers.dropExpired(seconds(1)),
        ]
        expect(typeof typeCases).toBe('function')
    })
})

// feat-273: the freshness and recovery checks of shared/mfa take an instant and a window in
// Seconds, as the staff policy does since feat-272.
describe('shared/mfa time checks', () => {
    it('isFresh / isActiveRecovery take UnixMs and Seconds', () => {
        const auth = sessionAuthOf(undefined)
        const typeCases = (): unknown[] => [
            isFresh(auth, 'otp', nowUnixMs(), seconds(300)),
            isActiveRecovery(auth, nowUnixMs()),
            // @ts-expect-error a bare window names no unit
            isFresh(auth, 'otp', nowUnixMs(), 300),
            // @ts-expect-error a window in milliseconds is not one in seconds
            isFresh(auth, 'otp', nowUnixMs(), ms(300_000)),
            // @ts-expect-error Date.now() is no UnixMs until it is branded
            isActiveRecovery(auth, Date.now()),
        ]
        expect(typeof typeCases).toBe('function')
        expect(isFresh(auth, 'otp', nowUnixMs(), seconds(300))).toBe(false)
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
