import { looksLikePhoneNumber } from 'shared/patterns'

export function isEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/** A phone number typed where an e-mail or a phone number is accepted: it is not an e-mail. */
export function looksLikeIdentifierPhone(value: string): boolean {
    const trimmed = value.trim()
    return looksLikePhoneNumber(trimmed) && !isEmail(trimmed)
}
