import { describe, expect, expectTypeOf, it } from 'vitest'

import { wsMessageValidator } from './ws-message-validator.js'

import type { Validator } from '#vendor/contracts/validator.js'
import type { WsMessage } from '#vendor/types/types.js'

describe('wsMessageValidator', () => {
    it('stays typed as Validator<WsMessage>', () => {
        expectTypeOf(wsMessageValidator).toExtend<Validator<WsMessage>>()
    })
})

// feat-180 (ADR 0006, Д-WS1): the envelope may carry the request id the reply echoes.
describe('wsMessageValidator: the request id', () => {
    const base = { event: 'api/support/support_chat', timestamp: 1, payload: {} }

    it('accepts a message with an id and one without', () => {
        expect(wsMessageValidator.validate({ ...base, id: 'req-1' }).ok).toBe(true)
        expect(wsMessageValidator.validate(base).ok).toBe(true)
    })

    it('refuses an id that is empty, longer than 64 or not a string', () => {
        expect(wsMessageValidator.validate({ ...base, id: '' }).ok).toBe(false)
        expect(wsMessageValidator.validate({ ...base, id: 'x'.repeat(65) }).ok).toBe(false)
        expect(wsMessageValidator.validate({ ...base, id: 7 }).ok).toBe(false)
    })
})
