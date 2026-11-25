import { describe, expect, it } from 'vitest'

import { parseMfaKeysArgs } from './mfa-keys-args.js'

describe('parseMfaKeysArgs (feat-260)', () => {
    it('defaults to a new value, printed', () => {
        expect(parseMfaKeysArgs([])).toEqual({ mode: 'new', write: false })
    })

    it('reads --write, --rotate and --check', () => {
        expect(parseMfaKeysArgs(['--write'])).toEqual({ mode: 'new', write: true })
        expect(parseMfaKeysArgs(['--rotate'])).toEqual({ mode: 'rotate', write: false })
        expect(parseMfaKeysArgs(['--write', '--rotate'])).toEqual({ mode: 'rotate', write: true })
        expect(parseMfaKeysArgs(['--check'])).toEqual({ mode: 'check', write: false })
    })

    it('refuses an unknown, a repeated or a combined --check argument', () => {
        expect(() => parseMfaKeysArgs(['--force'])).toThrow(/Unknown argument "--force"/)
        expect(() => parseMfaKeysArgs(['--rotate', '--rotate'])).toThrow(/given twice/)
        expect(() => parseMfaKeysArgs(['--check', '--write'])).toThrow(/--check takes no other/)
        expect(() => parseMfaKeysArgs(['--rotate', '--check'])).toThrow(/--check takes no other/)
    })
})
