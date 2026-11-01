import { test } from 'node:test'
import assert from 'node:assert/strict'

import { type } from '@arktype/type'

import { CsrfRejectReason, ErrorCode, ErrorCodeValues } from '../dist/errors/index.js'
import { ErrorCodeSchema } from '../dist/responses/error-code-schema.js'
import { EntityIdSchema } from '../dist/brands/index.js'
import {
    SUPPORT_HISTORY_DEFAULT_PAGE_SIZE,
    SUPPORT_HISTORY_MAX_PAGE_SIZE,
    SUPPORT_MESSAGE_MAX_LENGTH,
} from '../dist/limits/index.js'
import {
    PushSubscriptionTestInputSchema,
    SupportChatHistoryQuerySchema,
    SupportChatInputSchema,
} from '../dist/schemas/index.js'
import * as root from '../dist/index.js'

// ErrorCodeValues is derived from ErrorCode, so the two cannot drift; what is worth pinning is that
// the response schema takes exactly these codes and nothing else.
test('ErrorCodeSchema accepts every ErrorCode and nothing else', () => {
    assert.deepEqual([...ErrorCodeValues], Object.values(ErrorCode))
    assert.equal(new Set(ErrorCodeValues).size, ErrorCodeValues.length)
    for (const code of Object.values(ErrorCode)) {
        assert.equal(ErrorCodeSchema(code), code)
    }
    for (const bad of ['', 'BAD_REQUEST', 'teapot', 400, null]) {
        assert.ok(ErrorCodeSchema(bad) instanceof type.errors, JSON.stringify(bad))
    }
})

test('every CsrfRejectReason is a distinct snake_case word', () => {
    const reasons = Object.values(CsrfRejectReason)
    assert.equal(new Set(reasons).size, reasons.length)
    for (const reason of reasons) assert.match(reason, /^[a-z]+(_[a-z]+)*$/)
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

test('a support message may carry a client message id of safe characters', () => {
    const id = '3f2b8c1e-9d4a-4f6b-8a1e-0c5d7e9f1a2b'
    assert.deepEqual(SupportChatInputSchema({ message: 'hi', clientMessageId: id }), {
        message: 'hi',
        clientMessageId: id,
    })
    for (const bad of ['', 'a'.repeat(65), 'has space', 'semi;colon', 42]) {
        assert.ok(
            SupportChatInputSchema({ message: 'hi', clientMessageId: bad }) instanceof type.errors,
            JSON.stringify(bad),
        )
    }
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

// The history is read a page at a time: the UI asks for the latest page and then for the ones
// before it (feat-063, D3). An unbounded read used to return the whole conversation.
test('the support history query is bounded and takes a numeric cursor', () => {
    assert.equal(SUPPORT_HISTORY_DEFAULT_PAGE_SIZE, 50)
    assert.equal(SUPPORT_HISTORY_MAX_PAGE_SIZE, 100)

    assert.deepEqual(SupportChatHistoryQuerySchema({}), { limit: 50 })
    assert.deepEqual(SupportChatHistoryQuerySchema({ limit: '20', before: '812' }), {
        limit: 20,
        before: '812',
    })
    assert.deepEqual(SupportChatHistoryQuerySchema({ limit: '100' }), { limit: 100 })

    for (const limit of ['0', '101', '-1', '1.5', 'many', '']) {
        assert.ok(
            SupportChatHistoryQuerySchema({ limit }) instanceof type.errors,
            `limit ${JSON.stringify(limit)}`,
        )
    }
    // A cursor is a row id: digits, no leading zero, and small enough for a bigint column.
    for (const before of ['0', '007', '-5', 'abc', '1e3', ' 1', '', '9'.repeat(19)]) {
        assert.ok(
            SupportChatHistoryQuerySchema({ before }) instanceof type.errors,
            `before ${JSON.stringify(before)}`,
        )
    }
    assert.ok(
        SupportChatHistoryQuerySchema({ before: '9'.repeat(18) }) instanceof type.errors === false,
    )
})
