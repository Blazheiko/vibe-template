import { describe, expect, it, vi } from 'vitest'

import { reauthState, withReauth } from '@/composables/useReauth'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р15): withReauth opens the dialog only with the proofs
// of the refusal, repeats the request once after a step-up, and sends the user to sign in again
// when no step-up can help.
const refusal = (reason: string, proofs?: string[]) => ({
    data: {
        status: 'error',
        code: 'forbidden',
        message: 'no',
        reason,
        ...(proofs !== undefined ? { details: { kind: 'reauth_required', proofs } } : {}),
    },
    error: { message: 'no', transportCode: 403 },
})
const ok = { data: { status: 'success' }, error: null }

describe('withReauth (feat-245 Р15)', () => {
    it('an answer that is not a refusal passes through without a dialog', async () => {
        const call = vi.fn().mockResolvedValue(ok)
        const outcome = await withReauth(call)
        expect(outcome).toEqual({ response: ok, signInAgain: false })
        expect(call).toHaveBeenCalledOnce()
        expect(reauthState.open).toBe(false)
    })

    it('reauth_required: the dialog gets exactly the listed proofs; one repeat after it', async () => {
        const call = vi
            .fn()
            .mockResolvedValueOnce(refusal('reauth_required', ['totp', 'bogus']))
            .mockResolvedValueOnce(ok)
        const pending = withReauth(call)
        await vi.waitFor(() => {
            expect(reauthState.open).toBe(true)
        })
        expect(reauthState.proofs).toEqual(['totp'])
        reauthState.resolve?.(true)
        expect((await pending).response).toBe(ok)
        expect(call).toHaveBeenCalledTimes(2)
    })

    it('a cancelled dialog keeps the refusal and does not repeat', async () => {
        const first = refusal('reauth_required', ['password'])
        const call = vi.fn().mockResolvedValueOnce(first)
        const pending = withReauth(call)
        await vi.waitFor(() => {
            expect(reauthState.open).toBe(true)
        })
        reauthState.resolve?.(false)
        expect((await pending).response).toBe(first)
        expect(call).toHaveBeenCalledOnce()
    })

    it.each(['sign_in_again_required', 'mfa_session_required'])(
        '%s sends the user to sign in again, without a dialog',
        async (reason) => {
            const call = vi.fn().mockResolvedValue(refusal(reason))
            const outcome = await withReauth(call)
            expect(outcome.signInAgain).toBe(true)
            expect(reauthState.open).toBe(false)
        },
    )
})
