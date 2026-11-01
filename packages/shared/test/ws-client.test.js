import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyWsMessage, normalizeApiPrefix } from '../dist/ws-client/index.js'

// feat-075 (I): one copy for the app and the API playground.

test('an API response is recognised by its pending request, under any prefix', () => {
    assert.equal(classifyWsMessage('api/user/me', true), 'api')
    assert.equal(classifyWsMessage('v1/user/me', true), 'api')
    assert.equal(classifyWsMessage('api/user/me', false), 'unknown')
})

test('service and broadcast events are kept apart from API responses', () => {
    assert.equal(classifyWsMessage('service:error', true), 'service-error')
    assert.equal(classifyWsMessage('service:error', false), 'service-error')
    assert.equal(classifyWsMessage('service:pong', false), 'service')
    assert.equal(classifyWsMessage('service:pong', true), 'service')
    assert.equal(classifyWsMessage('broadcast:admin_user_online_remove', false), 'broadcast')
    assert.equal(classifyWsMessage('broadcast:x', true), 'broadcast')
})

test('normalizeApiPrefix trims slashes and spaces, and falls back to api', () => {
    const table = [
        [undefined, 'api'],
        ['', 'api'],
        ['   ', 'api'],
        ['/', 'api'],
        ['///', 'api'],
        ['api', 'api'],
        [' /v1/ ', 'v1'],
        ['/v1/', 'v1'],
        ['v1', 'v1'],
        ['internal/v2', 'internal/v2'],
        ['/internal/v2/', 'internal/v2'],
    ]
    for (const [raw, expected] of table) {
        assert.equal(normalizeApiPrefix(raw), expected, JSON.stringify(raw))
    }
})

test('the module carries no dependency, so the browser can import it', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../dist/ws-client/index.js', import.meta.url), 'utf8')
    assert.doesNotMatch(source, /^import /m)
})
