import { describe, expect, it } from 'vitest'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from 'shared/limits'

import en from '../en'
import pl from '../pl'
import uk from '../uk'

/**
 * feat-208: the texts name the password limits as numbers. They must be the numbers of
 * `shared/limits`, which the server enforces: a text that says 32 next to a limit of 128
 * tells a user to shorten a password the server would take.
 */
describe.each([
    ['en', en],
    ['uk', uk],
    ['pl', pl],
])('password limits in the %s texts', (_name, messages) => {
    it('names the longest password', () => {
        expect(messages.auth.errorPasswordMaxLength).toContain(String(PASSWORD_MAX_LENGTH))
        expect(messages.account.security.errorNewPasswordLength).toContain(
            String(PASSWORD_MAX_LENGTH),
        )
    })

    it('names the shortest password', () => {
        expect(messages.auth.errorPasswordLength).toContain(String(PASSWORD_MIN_LENGTH))
        expect(messages.account.security.errorNewPasswordLength).toContain(
            String(PASSWORD_MIN_LENGTH),
        )
    })
})
