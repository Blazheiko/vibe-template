import type { Redis } from 'ioredis'
import type { Milliseconds, Seconds } from 'shared/brand'

// feat-270 (plan Р7, T39): the unit of a Redis expiry is part of the command (EX / SETEX take
// seconds, PX / PEXPIRE milliseconds), and ioredis types both as a bare number, so a duration in
// the wrong unit compiles. Backend code sets an expiry only through these helpers (feat-272: the
// session layer of vendor/ too, so the module lives here); ESLint forbids the raw forms
// (eslint.config.ts). A Lua script receives its TTL as text through
// `secondsArg` / `msArg`, which name the unit the script expects.

type SetClient = Pick<Redis, 'set'>
type GetExClient = Pick<Redis, 'getex'>

/** SET with an expiry in seconds (EX). */
export const setWithTtlSeconds = (
    client: SetClient,
    key: string,
    value: string,
    ttl: Seconds,
): Promise<'OK'> => client.set(key, value, 'EX', ttl)

/** SET … EX … NX: the key is written only when it does not exist; null when it does. */
export const setIfAbsentWithTtlSeconds = (
    client: SetClient,
    key: string,
    value: string,
    ttl: Seconds,
): Promise<'OK' | null> => client.set(key, value, 'EX', ttl, 'NX')

/** GETEX … EX: reads the value and renews its expiry in seconds; null when the key is gone. */
export const getAndRenewTtlSeconds = (
    client: GetExClient,
    key: string,
    ttl: Seconds,
): Promise<string | null> => client.getex(key, 'EX', ttl)

/** SET … PX … NX: the key is written only when it does not exist; null when it does. */
export const setIfAbsentWithTtlMs = (
    client: SetClient,
    key: string,
    value: string,
    ttl: Milliseconds,
): Promise<'OK' | null> => client.set(key, value, 'PX', ttl, 'NX')

/** A TTL in seconds as an ARGV of a Lua script that passes it to EX / EXPIRE. */
export const secondsArg = (ttl: Seconds): string => String(ttl)

/** A TTL in milliseconds as an ARGV of a Lua script that passes it to PX / PEXPIRE. */
export const msArg = (ttl: Milliseconds): string => String(ttl)
