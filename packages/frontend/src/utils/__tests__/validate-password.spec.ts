import { describe, expect, it } from 'vitest'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from 'shared/limits'
import { PASSWORD_PROBLEM_MESSAGE_KEY, passwordLengthProblem } from '../validate-password'
import en from '@/locales/en'

describe('passwordLengthProblem', () => {
    it('says what is wrong, by the limits the server enforces', () => {
        expect(passwordLengthProblem('')).toBe('empty')
        expect(passwordLengthProblem('p'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('tooShort')
        expect(passwordLengthProblem('p'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe('tooLong')
    })

    it('accepts both ends of the range', () => {
        expect(passwordLengthProblem('p'.repeat(PASSWORD_MIN_LENGTH))).toBeNull()
        expect(passwordLengthProblem('p'.repeat(PASSWORD_MAX_LENGTH))).toBeNull()
    })

    it('counts characters, as the schemas do, and does not trim', () => {
        expect(passwordLengthProblem(' '.repeat(PASSWORD_MIN_LENGTH))).toBeNull()
    })
})

describe('PASSWORD_PROBLEM_MESSAGE_KEY', () => {
    it('points every problem at a message the English locale has', () => {
        const auth = (en as { auth: Record<string, string> }).auth
        for (const key of Object.values(PASSWORD_PROBLEM_MESSAGE_KEY)) {
            expect(typeof auth[key.replace('auth.', '')]).toBe('string')
        }
    })
})
