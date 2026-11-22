import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import en from '@/locales/en'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7, Р8, Р15): the sign-in security section, with the
// API, the router and the QR library replaced.

const mfa = vi.hoisted(() => ({
    status: vi.fn(),
    totpSetup: vi.fn(),
    totpConfirm: vi.fn(),
    totpDisable: vi.fn(),
    regenerateRecoveryCodes: vi.fn(),
}))
const auth = vi.hoisted(() => ({ recoveryFinish: vi.fn() }))
// feat-246: the passkey list of the section.
const passkeys = vi.hoisted(() => ({
    list: vi.fn(),
    registerOptions: vi.fn(),
    register: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
}))
const push = vi.hoisted(() => vi.fn())
const store = vi.hoisted(() => ({ setRecovery: vi.fn(), clearUser: vi.fn() }))
vi.mock('@/utils/api', () => ({ mfaApi: mfa, authApi: auth, passkeyApi: passkeys }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/stores/user', () => ({ useUserStore: () => store }))
vi.mock('qrcode', () => ({ toDataURL: () => Promise.resolve('data:image/png;base64,QR') }))

const { default: SignInSecurity } = await import('../SignInSecurity.vue')
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

const status = (over: Record<string, unknown> = {}) => ({
    data: {
        status: 'success',
        totp: { enabled: false, createdAt: null },
        passkeys: 0,
        recoveryCodesRemaining: 0,
        recoveryContact: true,
        stepUpProofs: ['password'],
        recovery: null,
        ...over,
    },
    error: null,
})

const mountSection = async () => {
    const wrapper = mount(SignInSecurity, { global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
}

beforeEach(() => {
    vi.clearAllMocks()
    passkeys.list.mockResolvedValue({ data: { status: 'success', passkeys: [] }, error: null })
})

describe('SignInSecurity (feat-245)', () => {
    it('sets up the authenticator app: QR, key, code, then ten codes shown once', async () => {
        mfa.status
            .mockResolvedValueOnce(status())
            .mockResolvedValue(
                status({ totp: { enabled: true, createdAt: 'x' }, recoveryCodesRemaining: 10 }),
            )
        mfa.totpSetup.mockResolvedValue({
            data: {
                status: 'success',
                enrollmentId: 'e1',
                secret: 'JBSWY3DPEHPK3PXP',
                otpauthUri: 'otpauth://totp/x',
            },
            error: null,
        })
        const codes = Array.from({ length: 10 }, (_, i) => `aaaa-bbbb-cccc-000${String(i)}`)
        mfa.totpConfirm.mockResolvedValue({
            data: { status: 'success', recoveryCodes: codes },
            error: null,
        })
        const wrapper = await mountSection()
        expect(wrapper.get('[data-testid="mfa-totp-state"]').text()).toContain('is off')

        await wrapper.get('[data-testid="mfa-setup-start"]').trigger('click')
        await flushPromises()
        expect(wrapper.get('[data-testid="mfa-setup"] img').attributes('src')).toContain('QR')
        expect(wrapper.get('[data-testid="mfa-secret"]').text()).toBe('JBSWY3DPEHPK3PXP')

        await wrapper.get('[data-testid="mfa-setup-code"]').setValue('123 456')
        await wrapper.get('[data-testid="mfa-setup-confirm"]').trigger('click')
        await flushPromises()
        expect(mfa.totpConfirm).toHaveBeenCalledWith({ enrollmentId: 'e1', code: '123456' })
        expect(wrapper.findAll('[data-testid="mfa-codes"] li')).toHaveLength(10)
        expect(wrapper.get('[data-testid="mfa-codes-left"]').text()).toContain('10')
    })

    it('without a verified contact the first factor cannot be turned on', async () => {
        mfa.status.mockResolvedValue(status({ recoveryContact: false }))
        const wrapper = await mountSection()
        expect(wrapper.find('[data-testid="mfa-need-contact"]').exists()).toBe(true)
        expect(wrapper.get('[data-testid="mfa-setup-start"]').attributes('disabled')).toBeDefined()
    })

    it('few codes left: a warning; turning off asks for confirmation first', async () => {
        mfa.status.mockResolvedValue(
            status({ totp: { enabled: true, createdAt: 'x' }, recoveryCodesRemaining: 2 }),
        )
        mfa.totpDisable.mockResolvedValue({
            data: { status: 'success', mfaDisabled: true },
            error: null,
        })
        const wrapper = await mountSection()
        expect(wrapper.get('[data-testid="mfa-codes-left"]').text()).toContain('Create new ones')
        await wrapper.get('[data-testid="mfa-disable"]').trigger('click')
        expect(mfa.totpDisable).not.toHaveBeenCalled()
        await wrapper.get('[data-testid="confirm-accept"]').trigger('click')
        await flushPromises()
        expect(mfa.totpDisable).toHaveBeenCalledOnce()
    })

    it('a recovery session: the steps, no turn-off, new codes only after the replacement, finish', async () => {
        const recovery = { expiresAt: '2030-01-01T00:00:00.000Z', replaced: false }
        mfa.status.mockResolvedValue(status({ totp: { enabled: true, createdAt: 'x' }, recovery }))
        auth.recoveryFinish.mockResolvedValue({ data: { status: 'success' }, error: null })
        const wrapper = await mountSection()
        expect(wrapper.find('[data-testid="mfa-recovery"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="mfa-disable"]').exists()).toBe(false)
        expect(wrapper.find('[data-testid="mfa-regenerate"]').exists()).toBe(false)
        expect(store.setRecovery).toHaveBeenCalledWith(recovery)

        await wrapper.get('[data-testid="mfa-recovery-finish"]').trigger('click')
        await flushPromises()
        expect(auth.recoveryFinish).toHaveBeenCalledOnce()
        expect(store.clearUser).toHaveBeenCalled()
        expect(push).toHaveBeenCalledWith('/login')
    })

    it('a passkey counts as a factor: listed, with codes left and new codes (feat-246)', async () => {
        mfa.status.mockResolvedValue(status({ passkeys: 1, recoveryCodesRemaining: 9 }))
        passkeys.list.mockResolvedValue({
            data: {
                status: 'success',
                passkeys: [
                    {
                        id: '1',
                        name: 'Laptop',
                        deviceType: 'multiDevice',
                        backedUp: true,
                        createdAt: '2026-11-01T10:00:00.000Z',
                        lastUsedAt: null,
                    },
                ],
            },
            error: null,
        })
        const wrapper = await mountSection()
        await flushPromises()
        expect(wrapper.get('[data-testid="passkey-name"]').text()).toBe('Laptop')
        expect(wrapper.get('[data-testid="mfa-codes-left"]').text()).toContain('9')
        expect(wrapper.find('[data-testid="mfa-regenerate"]').exists()).toBe(true)
    })
})
