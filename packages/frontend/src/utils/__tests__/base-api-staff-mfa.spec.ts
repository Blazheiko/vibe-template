import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р10): a 403 of the staff MFA rule from the admin area
// is announced once on the bus; the same reasons elsewhere, and other refusals, are not.

const emitMock = vi.hoisted(() => vi.fn())

vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi: vi.fn() }),
}))
vi.mock('../event-bus', () => ({ useEventBus: () => ({ emit: emitMock }) }))

const refusal = (reason: string, status = 403): Response =>
    new Response(
        JSON.stringify({ status: 'error', code: 'forbidden', message: 'Access denied', reason }),
        { status, headers: { 'Content-Type': 'application/json' } },
    )

const load = async (reply: Response) => {
    globalThis.fetch = vi.fn(() => Promise.resolve(reply))
    const csrf = await import('../csrf-token')
    csrf.confirmCsrfToken('a'.repeat(43), '1')
    const module = await import('../base-api')
    module.setCurrentUserIdProvider(() => '1')
    return module.default
}

const staffEvents = () => emitMock.mock.calls.filter(([name]) => name === 'staff_mfa_refused')

describe('base-api: the staff MFA refusal (feat-247)', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    it.each([
        ['mfa_required', '/api/admin/users'],
        ['mfa_session_required', '/api/admin/knowledge-base?page=1'],
        ['mfa_session_required', '/api/prompts'],
        ['mfa_required', '/api/prompts/support'],
    ])('announces 403 %s of %s', async (reason, route) => {
        const api = await load(refusal(reason))
        const { error } = await api.http('GET', route)

        expect(error).not.toBeNull()
        expect(staffEvents()).toEqual([['staff_mfa_refused', reason]])
    })

    it.each([
        ['another reason of the admin area', 'reauth_required', '/api/admin/users', 403],
        ['the reason outside the admin area', 'mfa_session_required', '/api/auth/reauth', 403],
        ['a route that only contains the word', 'mfa_required', '/api/account/administer', 403],
        ['another status', 'mfa_required', '/api/admin/users', 409],
    ])('ignores %s', async (_name, reason, route, status) => {
        const api = await load(refusal(reason, status))
        await api.http('GET', route)

        expect(staffEvents()).toEqual([])
    })
})
