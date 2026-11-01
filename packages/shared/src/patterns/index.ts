// Shapes of values the frontend and the backend both recognise. A module of its own, with no
// library behind it (the phone library of `shared/utils` is large): the browser can import it.

/** The canonical id of a database row as a string: digits, no leading zero, not zero. */
export const ENTITY_ID_PATTERN = /^[1-9]\d*$/

/**
 * Whether a string looks like a phone number, without saying it is valid: enough digits and
 * the characters a number is written with. Telling a phone from an e-mail in one field, nothing
 * more; `normalizePhoneNumber` of `shared/utils` is what decides validity.
 */
export function looksLikePhoneNumber(input: string): boolean {
    return /[+\d][\d()\-\s]{5,}/.test(input.trim())
}
