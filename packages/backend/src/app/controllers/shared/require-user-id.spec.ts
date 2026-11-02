import { describe, expect, it } from 'vitest'
import { requireUserId } from './require-user-id.js'

// feat-084 (H6): who is signed in, for the controllers that must answer 401 otherwise.

const withAuth = (check: boolean, userId: string | null): Parameters<typeof requireUserId>[0] =>
    ({ auth: { check: () => check, getUserId: () => userId } }) as never

describe('requireUserId', () => {
    it('is the user id as a bigint when someone is signed in', () => {
        expect(requireUserId(withAuth(true, '42'))).toBe(42n)
    })

    it('is null when nobody is signed in', () => {
        expect(requireUserId(withAuth(false, null))).toBeNull()
    })

    it('is null when the session says signed in but has no usable id', () => {
        expect(requireUserId(withAuth(true, null))).toBeNull()
    })

    it('is null when the id is there but the session is not signed in (an empty id)', () => {
        expect(requireUserId(withAuth(false, ''))).toBeNull()
    })

    it('does not look at the id of a session that is not signed in', () => {
        let asked = false
        const context = {
            auth: {
                check: () => false,
                getUserId: () => {
                    asked = true
                    return '1'
                },
            },
        } as never
        expect(requireUserId(context)).toBeNull()
        expect(asked).toBe(false)
    })
})
