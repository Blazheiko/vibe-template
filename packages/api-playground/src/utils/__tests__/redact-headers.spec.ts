import { describe, expect, it } from 'vitest'

import { redactHeaders } from '../redact-headers'

// The playground logs each request it makes. A header that carries a credential is shown as a
// placeholder, whatever the case of its name.
describe('redactHeaders', () => {
    it('hides credentials and leaves the rest', () => {
        expect(
            redactHeaders({
                'Content-Type': 'application/json',
                Authorization: 'Bearer secret',
                Cookie: 'session=abc',
                'Set-Cookie': 'session=abc',
                'X-CSRF-Token': 'csrf-value',
                'X-Api-Key': 'key',
                'Proxy-Authorization': 'Basic xyz',
                'x-access-token': 'tok',
                Accept: 'application/json',
            }),
        ).toEqual({
            'Content-Type': 'application/json',
            Authorization: '[redacted]',
            Cookie: '[redacted]',
            'Set-Cookie': '[redacted]',
            'X-CSRF-Token': '[redacted]',
            'X-Api-Key': '[redacted]',
            'Proxy-Authorization': '[redacted]',
            'x-access-token': '[redacted]',
            Accept: 'application/json',
        })
    })

    it.each(['authorization', 'AUTHORIZATION', 'cOoKiE', 'x-auth-token', 'X-Session-Token'])(
        'recognises %s whatever its case',
        (name) => {
            expect(redactHeaders({ [name]: 'secret' })[name]).toBe('[redacted]')
        },
    )

    it('does not change the original', () => {
        const original = { Authorization: 'Bearer secret' }

        redactHeaders(original)

        expect(original.Authorization).toBe('Bearer secret')
    })

    it('copes with no headers', () => {
        expect(redactHeaders({})).toEqual({})
    })
})
