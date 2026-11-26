// Branded types without a library (feat-262, ADR 0007 in feat-263): the browser may import this
// module as a value, so it imports nothing but the shared patterns. `shared/brands` keeps the
// ArkType schemas; the frontend takes only types from there (check-bundle-graph).

import { ENTITY_ID_PATTERN } from '../patterns/index.js'

declare const brandKey: ' brand'

/**
 * A primitive `T` that only a constructor or a schema gives out, told apart by `Id`. The shape is
 * the one ArkType's `.brand()` infers (`@ark/util` `Brand`), so a schema's output and a value
 * branded here are the same type; `brands/type-checks.ts` stops the build if the two drift apart.
 */
export type Brand<T, Id> = T & { readonly [brandKey]: [T, Id] }

/** The largest value of a PostgreSQL `bigint` (and of every id column), as its decimal text. */
export const MAX_ENTITY_ID = '9223372036854775807'

/**
 * Whether `value` is the canonical id of a row: decimal digits, no leading zero, not zero, and no
 * larger than a PostgreSQL `bigint` holds. The bound is a string comparison of two 19-digit
 * numbers, so the check needs no `BigInt` and runs the same in the browser.
 */
export function isValidEntityId(value: string): boolean {
    return (
        ENTITY_ID_PATTERN.test(value) &&
        (value.length < MAX_ENTITY_ID.length || value <= MAX_ENTITY_ID)
    )
}

// Units of time (feat-267, plan Р7): a duration in milliseconds, a duration in seconds, an
// instant in milliseconds and one in whole seconds since the epoch (feat-270) are four types, so a TTL in seconds cannot reach a PX
// call and a `Date.now()` cannot stand for a duration. Arithmetic on a brand gives a plain number,
// so the operations below are the way to get a branded result: `ms(a + b)` would also take a sum
// of seconds and milliseconds. Durations are rounded up when they become seconds (a TTL or a
// Retry-After must not end before the real one); instants are rounded down.

export type Milliseconds = Brand<number, 'Milliseconds'>
export type Seconds = Brand<number, 'Seconds'>
/** An instant: milliseconds since the Unix epoch, as `Date.now()` returns it. */
export type UnixMs = Brand<number, 'UnixMs'>
/** An instant: whole seconds since the Unix epoch (a JWT-style `iat`), not a duration. */
export type UnixSeconds = Brand<number, 'UnixSeconds'>

/** A duration given in milliseconds. */
export const ms = (value: number): Milliseconds => value as Milliseconds

/** A duration given in seconds. */
export const seconds = (value: number): Seconds => value as Seconds

/** An instant given in milliseconds since the epoch. */
export const unixMs = (value: number): UnixMs => value as UnixMs

/** The current instant. */
export const nowUnixMs = (): UnixMs => Date.now() as UnixMs

/** A duration in seconds as milliseconds. */
export const toMs = (duration: Seconds): Milliseconds => (duration * 1000) as Milliseconds

/** A duration in milliseconds as whole seconds, rounded up: a TTL never ends early. */
export const toSecondsCeil = (duration: Milliseconds): Seconds =>
    Math.ceil(duration / 1000) as Seconds

/** A duration in milliseconds as whole seconds, rounded down. */
export const toSecondsFloor = (duration: Milliseconds): Seconds =>
    Math.floor(duration / 1000) as Seconds

/** An instant as whole seconds since the epoch, rounded down (a timestamp never in the future). */
export const unixSecondsOf = (instant: UnixMs): UnixSeconds =>
    Math.floor(instant / 1000) as UnixSeconds

/** The instant `delta` after `at`. */
export const addMs = (at: UnixMs, delta: Milliseconds): UnixMs => (at + delta) as UnixMs

/** The duration from `earlier` to `later` (negative when `later` is before `earlier`). */
export const diffMs = (later: UnixMs, earlier: UnixMs): Milliseconds =>
    (later - earlier) as Milliseconds

// Wire values of the responses (feat-268, plan Р8). The schemas live in `shared/brands`; these
// are the same types, so the backend can brand a value it made itself without ArkType.

/** The id of a row as it travels in JSON: canonical decimal text (`isValidEntityId`). */
export type EntityId = Brand<string, 'EntityId'>
/** A moment as ISO 8601 text, as `Date.prototype.toISOString` writes it. */
export type IsoDateTime = Brand<string, 'IsoDateTime'>
/** An opaque page cursor: the client sends back what the server gave, and never builds one. */
export type Cursor = Brand<string, 'Cursor'>
/** The public id of a session (22 base64url characters of an HMAC); the session id is never sent. */
export type SessionPublicId = Brand<string, 'SessionPublicId'>

/** The ISO text of a date the server holds. */
export const toIsoDateTime = (date: Date): IsoDateTime => date.toISOString() as IsoDateTime
/** Like `toIsoDateTime`, keeping `null` for a missing date. */
export const toIsoDateTimeOrNull = (date: Date | null): IsoDateTime | null =>
    date === null ? null : toIsoDateTime(date)
