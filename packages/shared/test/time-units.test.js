import { test } from 'node:test'
import assert from 'node:assert/strict'

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
} from '../dist/brand/index.js'

// feat-267 (plan Р7): durations become seconds rounded up (a TTL or a Retry-After never ends
// early), instants rounded down (a timestamp is never in the future).
test('a duration in milliseconds becomes whole seconds rounded up, or down on request', () => {
    assert.equal(toSecondsCeil(ms(1)), 1)
    assert.equal(toSecondsCeil(ms(1000)), 1)
    assert.equal(toSecondsCeil(ms(1001)), 2)
    assert.equal(toSecondsCeil(ms(0)), 0)
    assert.equal(toSecondsFloor(ms(1999)), 1)
    assert.equal(toSecondsFloor(ms(999)), 0)
})

test('seconds become milliseconds', () => {
    assert.equal(toMs(seconds(60)), 60_000)
    assert.equal(toMs(seconds(0)), 0)
})

test('an instant is moved by a duration, and two instants give one', () => {
    const at = unixMs(1_000_000)
    assert.equal(addMs(at, ms(500)), 1_000_500)
    assert.equal(diffMs(unixMs(1_000_500), at), 500)
    assert.equal(diffMs(at, unixMs(1_000_500)), -500)
})

test('an instant in seconds since the epoch is rounded down', () => {
    assert.equal(unixSecondsOf(unixMs(1_999)), 1)
    const before = Date.now()
    const now = nowUnixMs()
    assert.ok(now >= before && now <= Date.now())
})
