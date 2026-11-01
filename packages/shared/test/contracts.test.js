import { test } from 'node:test'
import assert from 'node:assert/strict'

import { type } from '@arktype/type'

import {
    CSRF_REJECT_REASONS,
    CsrfRejectReason,
    ErrorCode,
    ErrorCodeValues,
} from '../dist/errors/index.js'
import { EntityIdSchema } from '../dist/brands/index.js'
import { SUPPORT_MESSAGE_MAX_LENGTH } from '../dist/limits/index.js'
import { PushSubscriptionTestInputSchema, SupportChatInputSchema } from '../dist/schemas/index.js'
import * as root from '../dist/index.js'

test('ErrorCode and ErrorCodeValues list the same codes', () => {
    assert.deepEqual([...ErrorCodeValues].sort(), Object.values(ErrorCode).sort())
    assert.equal(new Set(ErrorCodeValues).size, ErrorCodeValues.length)
})

test('CsrfRejectReason and CSRF_REJECT_REASONS list the same reasons', () => {
    assert.deepEqual([...CSRF_REJECT_REASONS].sort(), Object.values(CsrfRejectReason).sort())
    assert.equal(new Set(CSRF_REJECT_REASONS).size, CSRF_REJECT_REASONS.length)
})

test('EntityIdSchema accepts canonical positive integer ids only', () => {
    assert.equal(EntityIdSchema('42'), '42')
    for (const value of ['0', '007', '-1', '1.5', '', 'abc', ' 1']) {
        assert.ok(EntityIdSchema(value) instanceof type.errors, JSON.stringify(value))
    }
})

test('input schemas reject unknown keys and keep their limits', () => {
    assert.ok(PushSubscriptionTestInputSchema({ extra: 1 }) instanceof type.errors)
    assert.ok(PushSubscriptionTestInputSchema({ title: 'x'.repeat(201) }) instanceof type.errors)
    assert.deepEqual(PushSubscriptionTestInputSchema({ title: 't' }), { title: 't' })
    assert.ok(SupportChatInputSchema({ message: '' }) instanceof type.errors)
    assert.equal(SUPPORT_MESSAGE_MAX_LENGTH, 4000)
    assert.deepEqual(SupportChatInputSchema({ message: 'a'.repeat(SUPPORT_MESSAGE_MAX_LENGTH) }), {
        message: 'a'.repeat(SUPPORT_MESSAGE_MAX_LENGTH),
    })
    assert.ok(
        SupportChatInputSchema({ message: 'a'.repeat(SUPPORT_MESSAGE_MAX_LENGTH + 1) }) instanceof
            type.errors,
    )
    assert.deepEqual(SupportChatInputSchema({ message: 'hi', language: 'uk' }), {
        message: 'hi',
        language: 'uk',
    })
})

test('the package root re-exports the guards', () => {
    assert.equal(typeof root.isWsChannel, 'function')
    assert.ok(Array.isArray(root.WS_CHANNELS))
})

test('shared/limits has no schema library behind it, so the browser can import it', async () => {
    const source = await import('node:fs').then((fs) =>
        fs.readFileSync(new URL('../dist/limits/index.js', import.meta.url), 'utf8'),
    )
    assert.doesNotMatch(source, /^import /m)
    assert.equal(root.SUPPORT_MESSAGE_MAX_LENGTH, SUPPORT_MESSAGE_MAX_LENGTH)
})
