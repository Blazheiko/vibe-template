import { test } from 'node:test'
import assert from 'node:assert/strict'

import { describeDevice, parseUserAgent } from '../dist/utils/index.js'
import {
    ListSessionsResponseSchema,
    RevokeOtherSessionsResponseSchema,
    SessionViewSchema,
} from '../dist/responses/index.js'
import { ListSessionsQuerySchema } from '../dist/schemas/index.js'
import { BroadcastEventSchemas } from '../dist/schemas/index.js'

const isError = (result) => result !== null && typeof result === 'object' && 'summary' in result

// feat-233 (Р6): real User-Agent strings of the browsers and systems people use.
const FIXTURES = [
    [
        'Chrome on Windows',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        { browser: 'Chrome', os: 'Windows', deviceType: 'desktop' },
    ],
    [
        'Chrome on macOS',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        { browser: 'Chrome', os: 'macOS', deviceType: 'desktop' },
    ],
    [
        'Firefox on Linux',
        'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
        { browser: 'Firefox', os: 'Linux', deviceType: 'desktop' },
    ],
    [
        'Firefox on Ubuntu',
        'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
        { browser: 'Firefox', os: 'Linux', deviceType: 'desktop' },
    ],
    [
        'Safari on macOS',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
        { browser: 'Safari', os: 'macOS', deviceType: 'desktop' },
    ],
    [
        'Safari on iPhone',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
        { browser: 'Safari', os: 'iOS', deviceType: 'mobile' },
    ],
    [
        'Safari on iPad',
        'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
        { browser: 'Safari', os: 'iOS', deviceType: 'tablet' },
    ],
    [
        'Chrome on iPhone',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
        { browser: 'Chrome', os: 'iOS', deviceType: 'mobile' },
    ],
    [
        'Firefox on iPhone',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15',
        { browser: 'Firefox', os: 'iOS', deviceType: 'mobile' },
    ],
    [
        'Chrome on Android phone',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.81 Mobile Safari/537.36',
        { browser: 'Chrome', os: 'Android', deviceType: 'mobile' },
    ],
    [
        'Chrome on Android tablet',
        'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        { browser: 'Chrome', os: 'Android', deviceType: 'tablet' },
    ],
    [
        'Samsung Internet on Android',
        'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
        { browser: 'Samsung Internet', os: 'Android', deviceType: 'mobile' },
    ],
    [
        'Edge on Windows',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.51',
        { browser: 'Edge', os: 'Windows', deviceType: 'desktop' },
    ],
    [
        'Edge on Android',
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0',
        { browser: 'Edge', os: 'Android', deviceType: 'mobile' },
    ],
    [
        'Opera on Windows',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
        { browser: 'Opera', os: 'Windows', deviceType: 'desktop' },
    ],
    [
        'Chrome on ChromeOS',
        'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        { browser: 'Chrome', os: 'ChromeOS', deviceType: 'desktop' },
    ],
    [
        'Playwright headless Chromium on Linux',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.33 Safari/537.36',
        { browser: 'unknown', os: 'Linux', deviceType: 'desktop' },
    ],
]

for (const [name, ua, expected] of FIXTURES) {
    test(`parseUserAgent: ${name}`, () => {
        assert.deepEqual(parseUserAgent(ua), expected)
    })
}

test('parseUserAgent: empty, missing and garbage strings are unknown everywhere', () => {
    const unknown = { browser: 'unknown', os: 'unknown', deviceType: 'unknown' }
    for (const ua of ['', '   ', 'curl/8.7.1', 'x'.repeat(5000), '<script>', null, undefined]) {
        assert.deepEqual(parseUserAgent(ua), unknown, String(ua).slice(0, 20))
    }
})

test('parseUserAgent: a very long string is cut before parsing', () => {
    const ua = `Mozilla/5.0 (Windows NT 10.0) ${'x'.repeat(600)} Chrome/131.0`
    assert.deepEqual(parseUserAgent(ua), {
        browser: 'unknown',
        os: 'Windows',
        deviceType: 'desktop',
    })
})

test('describeDevice names what is known', () => {
    assert.equal(describeDevice({ browser: 'Chrome', os: 'macOS' }), 'Chrome on macOS')
    assert.equal(describeDevice({ browser: 'Chrome', os: 'macOS' }, 'на'), 'Chrome на macOS')
    assert.equal(describeDevice({ browser: 'unknown', os: 'Linux' }), 'Linux')
    assert.equal(describeDevice({ browser: 'Firefox', os: 'unknown' }), 'Firefox')
    assert.equal(describeDevice({ browser: 'unknown', os: 'unknown' }), null)
})

const view = {
    id: 'AbCdEfGhIjKlMnOpQrSt_-',
    current: true,
    browser: 'Chrome',
    os: 'macOS',
    deviceType: 'desktop',
    userAgent: 'Mozilla/5.0',
    ip: '203.0.113.7',
    method: 'oauth',
    provider: 'github',
    signedInAt: '2026-11-19T10:00:00.000Z',
    lastSeenAt: null,
    online: false,
}

test('SessionView: a 22-character public id and a known method', () => {
    assert.ok(!isError(SessionViewSchema(view)))
    assert.ok(isError(SessionViewSchema({ ...view, id: 'short' })))
    assert.ok(isError(SessionViewSchema({ ...view, id: crypto.randomUUID() })))
    assert.ok(isError(SessionViewSchema({ ...view, method: 'sms' })))
})

test('ListSessionsResponse: current may be null, others a list, nextCursor nullable', () => {
    assert.ok(
        !isError(
            ListSessionsResponseSchema({
                status: 'success',
                current: view,
                others: [{ ...view, current: false }],
                nextCursor: null,
            }),
        ),
    )
    assert.ok(
        !isError(
            ListSessionsResponseSchema({
                status: 'success',
                current: null,
                others: [],
                nextCursor: 'MTc2MzUwMDAwMDAwMDp4',
            }),
        ),
    )
})

test('RevokeOtherSessionsResponse: a renewal carries its tokens, a failed one none', () => {
    assert.ok(
        !isError(
            RevokeOtherSessionsResponseSchema({
                status: 'success',
                sessionRenewed: true,
                csrfToken: 'c',
                wsUrl: 'ws://x',
                wsToken: 't',
            }),
        ),
    )
    assert.ok(
        !isError(RevokeOtherSessionsResponseSchema({ status: 'success', sessionRenewed: false })),
    )
    assert.ok(
        isError(RevokeOtherSessionsResponseSchema({ status: 'success', sessionRenewed: true })),
    )
})

test('ListSessionsQuery: an optional base64url cursor', () => {
    assert.ok(!isError(ListSessionsQuerySchema({})))
    assert.ok(!isError(ListSessionsQuerySchema({ cursor: 'MTc2MzUwMDAwMDAwMDp4' })))
    assert.ok(isError(ListSessionsQuerySchema({ cursor: 'a b' })))
    assert.ok(isError(ListSessionsQuerySchema({ cursor: 'x'.repeat(129) })))
})

test('user_sessions_changed is a broadcast event without data', () => {
    assert.ok(!isError(BroadcastEventSchemas.user_sessions_changed({})))
})
