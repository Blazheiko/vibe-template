import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeApiPrefix } from '../dist/api-prefix/index.js'

// feat-193: one rule for the backend config and the client bundles.

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
