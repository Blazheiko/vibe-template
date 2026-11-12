import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertSameApiPrefix, resolveDevBackend } from '../dist/dev-backend/index.js'

// feat-192: the Vite proxies and the compiled API prefix follow the backend's own variables.

test('defaults to 127.0.0.1:3000 and api', () => {
    assert.deepEqual(resolveDevBackend({}, {}), {
        origin: 'http://127.0.0.1:3000',
        port: 3000,
        prefix: 'api',
    })
})

test('reads PORT, HOST and API_PATH_PREFIX from the backend .env', () => {
    const backend = resolveDevBackend(
        {},
        { PORT: '4100', HOST: 'localhost', API_PATH_PREFIX: '/v1/' },
    )
    assert.deepEqual(backend, { origin: 'http://localhost:4100', port: 4100, prefix: 'v1' })
})

test('the shell wins over the file, as dotenv does, even with an empty value', () => {
    const file = { PORT: '4100', API_PATH_PREFIX: 'v1' }
    assert.equal(resolveDevBackend({ PORT: '5000' }, file).port, 5000)
    assert.equal(resolveDevBackend({ API_PATH_PREFIX: '' }, file).prefix, 'api')
    assert.equal(resolveDevBackend({ PORT: '' }, file).port, 3000)
})

test('a wildcard HOST is reached over loopback, an IPv6 literal gets brackets', () => {
    assert.equal(resolveDevBackend({ HOST: '0.0.0.0' }).origin, 'http://127.0.0.1:3000')
    assert.equal(resolveDevBackend({ HOST: '::' }).origin, 'http://127.0.0.1:3000')
    assert.equal(resolveDevBackend({ HOST: '::1' }).origin, 'http://[::1]:3000')
})

test('a PORT the backend would refuse fails', () => {
    for (const port of ['0', '65536', 'abc', '30.5', '-1']) {
        assert.throws(() => resolveDevBackend({ PORT: port }), /PORT=/, port)
    }
})

test('VITE_API_PATH_PREFIX may only repeat the backend prefix', () => {
    assert.doesNotThrow(() => assertSameApiPrefix(undefined, 'v1'))
    assert.doesNotThrow(() => assertSameApiPrefix('', 'v1'))
    assert.doesNotThrow(() => assertSameApiPrefix('/v1/', 'v1'))
    assert.throws(
        () => assertSameApiPrefix('api', 'v1'),
        /differs from the backend API_PATH_PREFIX/,
    )
})
