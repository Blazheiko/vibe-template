import { describe, expect, it } from 'vitest'
import { ms, unixMs } from 'shared/brand'

import type {
    MfaBinding,
    MfaBindValue,
    MfaReservationId,
    MfaTicketId,
} from '#app/domain/secrets.js'
import type { MfaTicket, mfaTicketStore as Store } from './mfa-ticket.js'

// feat-270 (ADR 0007, plan Р5): the store compares the ticket's binding with the one a request
// carries, so it takes only an MfaBinding (the keyed hash), never the raw mfa_bind cookie value
// nor bare text. The type cases are checked by the compiler; the calls behind `() =>` never run.
describe('mfaTicketStore takes the MFA browser binding as a brand', () => {
    it('reserve and deleteIfOpen refuse a cookie value or a string', () => {
        const store = {} as typeof Store
        const id = 'ticket' as MfaTicketId
        const reservation = 'r' as MfaReservationId
        const binding = 'hash' as MfaBinding
        const cookieValue = 'cookie' as MfaBindValue
        const now = unixMs(0)
        const ttl = ms(1000)
        const typeCases = (): unknown[] => [
            store.reserve(id, binding, reservation, now, ttl),
            store.deleteIfOpen(id, binding),
            // @ts-expect-error the raw mfa_bind value is not its binding
            store.reserve(id, cookieValue, reservation, now, ttl),
            // @ts-expect-error bare text is not a binding
            store.reserve(id, 'hash', reservation, now, ttl),
            // @ts-expect-error the raw mfa_bind value is not its binding
            store.deleteIfOpen(id, cookieValue),
            // @ts-expect-error bare text is not a binding
            store.deleteIfOpen(id, 'hash'),
        ]
        expect(typeof typeCases).toBe('function')
    })

    it('a stored ticket carries an MfaBinding', () => {
        const ticket = {} as MfaTicket
        const cookieValue = 'cookie' as MfaBindValue
        const typeCases = (): unknown[] => [
            // @ts-expect-error the binding is compared with a binding, not with a cookie value
            ticket.binding === cookieValue,
        ]
        expect(typeof typeCases).toBe('function')
    })
})
