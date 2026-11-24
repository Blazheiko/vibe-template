import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import en from '@/locales/en'
import { useEventBus } from '@/utils/event-bus'

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
// feat-256: the end of a recovery session goes through the session lifecycle (item 5).
const lifecycle = vi.hoisted(() => ({ finishRecovery: vi.fn() }))
vi.mock('@/composables/useSessionLifecycle', () => ({ useSessionLifecycle: () => lifecycle }))
// feat-256: the browser's passkey support and ceremony (item 4); unsupported unless a test says.
const webauthn = vi.hoisted(() => ({ passkeysSupported: vi.fn(), createPasskey: vi.fn() }))
vi.mock('@/composables/usePasskeys', () => webauthn)

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
        staffFactor: null,
        ...over,
    },
    error: null,
})

const mountSection = async (props: Record<string, unknown> = {}) => {
    const wrapper = mount(SignInSecurity, { props, global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
}

beforeEach(() => {
    vi.clearAllMocks()
    passkeys.list.mockResolvedValue({ data: { status: 'success', passkeys: [] }, error: null })
    webauthn.passkeysSupported.mockResolvedValue(false)
    lifecycle.finishRecovery.mockResolvedValue('left')
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
        const wrapper = await mountSection()
        expect(wrapper.find('[data-testid="mfa-recovery"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="mfa-disable"]').exists()).toBe(false)
        expect(wrapper.find('[data-testid="mfa-regenerate"]').exists()).toBe(false)
        expect(store.setRecovery).toHaveBeenCalledWith(recovery)

        await wrapper.get('[data-testid="mfa-recovery-finish"]').trigger('click')
        await flushPromises()
        expect(lifecycle.finishRecovery).toHaveBeenCalledOnce()
        expect(wrapper.find('[data-testid="mfa-message"]').exists()).toBe(false)
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

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р10): what a staff account must do for the admin area.
describe('SignInSecurity: the staff MFA notice (feat-247)', () => {
    const notice = (wrapper: Awaited<ReturnType<typeof mountSection>>) =>
        wrapper.find('[data-testid="staff-mfa-notice"]')

    it('a staff account without a factor sees the banner, unasked', async () => {
        mfa.status.mockResolvedValue(status())
        const wrapper = await mountSection({ staff: true })
        expect(notice(wrapper).text()).toContain(en.account.mfa.staffFactorRequired)
        expect(wrapper.find('[data-testid="staff-mfa-sign-in"]').exists()).toBe(false)
    })

    it('a user account without a factor, or a staff one with it, sees none', async () => {
        mfa.status.mockResolvedValue(status())
        expect(notice(await mountSection()).exists()).toBe(false)
        mfa.status.mockResolvedValue(status({ passkeys: 1, recoveryCodesRemaining: 10 }))
        expect(notice(await mountSection({ staff: true })).exists()).toBe(false)
    })

    it('mfa_required without a factor: set one up', async () => {
        mfa.status.mockResolvedValue(status())
        const wrapper = await mountSection({ staff: true, staffReason: 'mfa_required' })
        expect(notice(wrapper).text()).toContain(en.account.mfa.staffFactorRequired)
    })

    it.each(['mfa_session_required', 'mfa_required'])(
        '%s with a factor: sign in again with it, back to the admin area',
        async (reason) => {
            mfa.status.mockResolvedValue(
                status({ totp: { enabled: true, createdAt: 'x' }, recoveryCodesRemaining: 10 }),
            )
            const emit = vi.spyOn(useEventBus(), 'emit')
            const wrapper = await mountSection({ staff: true, staffReason: reason })

            expect(notice(wrapper).text()).toContain(en.account.mfa.staffSessionRequired)
            await wrapper.find('[data-testid="staff-mfa-sign-in"]').trigger('click')
            expect(emit).toHaveBeenCalledWith('sign_in_again', '/admin')
        },
    )
})

// feat-248 (docs/plan/passkeys-mfa-plan.md, Р10, Д11): with MFA_STAFF_FACTOR=passkey only a
// passkey opens the admin area.
describe('SignInSecurity: the staff passkey mode (feat-248)', () => {
    const notice = (wrapper: Awaited<ReturnType<typeof mountSection>>) =>
        wrapper.find('[data-testid="staff-mfa-notice"]')
    const TOTP_ONLY = { totp: { enabled: true, createdAt: 'x' }, recoveryCodesRemaining: 10 }

    it('a staff account with TOTP and no passkey sees the passkey banner, unasked', async () => {
        mfa.status.mockResolvedValue(status({ ...TOTP_ONLY, staffFactor: 'passkey' }))
        const wrapper = await mountSection({ staff: true })
        expect(notice(wrapper).text()).toContain(en.account.mfa.staffPasskeyRequired)
        expect(wrapper.find('[data-testid="staff-mfa-sign-in"]').exists()).toBe(false)
    })

    it('a staff account without any factor is asked for a passkey too', async () => {
        mfa.status.mockResolvedValue(status({ staffFactor: 'passkey' }))
        const wrapper = await mountSection({ staff: true, staffReason: 'mfa_required' })
        expect(notice(wrapper).text()).toContain(en.account.mfa.staffPasskeyRequired)
    })

    it('with a passkey: no banner; refused for the session, sign in again with the passkey', async () => {
        const withPasskey = status({ ...TOTP_ONLY, passkeys: 1, staffFactor: 'passkey' })
        mfa.status.mockResolvedValue(withPasskey)
        expect(notice(await mountSection({ staff: true })).exists()).toBe(false)

        const emit = vi.spyOn(useEventBus(), 'emit')
        const wrapper = await mountSection({ staff: true, staffReason: 'mfa_session_required' })
        expect(notice(wrapper).text()).toContain(en.account.mfa.staffPasskeySessionRequired)
        await wrapper.find('[data-testid="staff-mfa-sign-in"]').trigger('click')
        expect(emit).toHaveBeenCalledWith('sign_in_again', '/admin')
    })

    it('turning off the factor a staff role needs explains the refusal (Р12)', async () => {
        mfa.status.mockResolvedValue(status({ ...TOTP_ONLY, staffFactor: 'any' }))
        mfa.totpDisable.mockResolvedValue({
            data: {
                status: 'error',
                code: 'conflict',
                message: 'A staff role needs a second factor',
                reason: 'mfa_required_for_role',
            },
            error: null,
        })
        const wrapper = await mountSection({ staff: true })
        await wrapper.get('[data-testid="mfa-disable"]').trigger('click')
        await wrapper.get('[data-testid="confirm-accept"]').trigger('click')
        await flushPromises()
        expect(wrapper.get('[data-testid="mfa-message"]').text()).toBe(
            en.account.mfa.errorStaffFactor,
        )
    })

    it('the any mode keeps the TOTP-only staff account without a banner', async () => {
        mfa.status.mockResolvedValue(status({ ...TOTP_ONLY, staffFactor: 'any' }))
        expect(notice(await mountSection({ staff: true })).exists()).toBe(false)
    })

    describe('feat-256 (docs/plan/mfa-review-fixes-7-plan.md)', () => {
        const startedSetup = async () => {
            mfa.status.mockResolvedValue(status())
            mfa.totpSetup.mockResolvedValue({
                data: {
                    status: 'success',
                    enrollmentId: 'e1',
                    secret: 'JBSWY3DPEHPK3PXP',
                    otpauthUri: 'otpauth://totp/x',
                },
                error: null,
            })
            const wrapper = await mountSection()
            await wrapper.get('[data-testid="mfa-setup-start"]').trigger('click')
            await flushPromises()
            await wrapper.get('[data-testid="mfa-setup-code"]').setValue('123456')
            return wrapper
        }
        const refused = (reason: string, transportCode: number) => ({
            data: { status: 'error', code: 'x', message: 'no', reason },
            error: { code: 'x', transportCode, message: 'no' },
        })

        it('item 3: a setup its kept proof no longer admits goes back to "Set up"', async () => {
            const wrapper = await startedSetup()
            mfa.totpConfirm.mockResolvedValue(refused('reauth_required', 403))
            await wrapper.get('[data-testid="mfa-setup-confirm"]').trigger('click')
            await flushPromises()
            expect(wrapper.find('[data-testid="mfa-setup"]').exists()).toBe(false)
            expect(wrapper.find('[data-testid="mfa-setup-start"]').exists()).toBe(true)
            expect(wrapper.text()).toContain(en.account.mfa.errorSetupRestart)
        })

        it('item 4: a TOTP confirmation with an unknown outcome keeps the setup and the code', async () => {
            const wrapper = await startedSetup()
            mfa.totpConfirm.mockResolvedValueOnce({
                data: null,
                error: { code: 'network', transportCode: 0, message: 'offline' },
            })
            await wrapper.get('[data-testid="mfa-setup-confirm"]').trigger('click')
            await flushPromises()
            expect(wrapper.find('[data-testid="mfa-setup"]').exists()).toBe(true)
            mfa.totpConfirm.mockResolvedValueOnce({
                data: { status: 'success', recoveryCodes: null },
                error: null,
            })
            await wrapper.get('[data-testid="mfa-setup-confirm"]').trigger('click')
            await flushPromises()
            expect(mfa.totpConfirm).toHaveBeenNthCalledWith(2, {
                enrollmentId: 'e1',
                code: '123456',
            })
        })

        it('item 4: a passkey registration with an unknown outcome is sent again as it is', async () => {
            mfa.status.mockResolvedValue(status())
            webauthn.passkeysSupported.mockResolvedValue(true)
            passkeys.registerOptions.mockResolvedValue({
                data: { status: 'success', enrollmentId: 'pe1', options: { challenge: 'c' } },
                error: null,
            })
            const registration = { id: 'cred', response: {} }
            webauthn.createPasskey.mockResolvedValue({ ok: true, value: registration })
            passkeys.register
                .mockResolvedValueOnce(refused('', 503))
                .mockResolvedValueOnce(refused('', 500))
                .mockResolvedValueOnce({
                    data: { status: 'success', passkey: {}, recoveryCodes: null },
                    error: null,
                })
            const wrapper = await mountSection()
            await wrapper.get('[data-testid="passkey-add"]').trigger('click')
            await flushPromises()
            // No new registration meanwhile: only "Try again".
            expect(wrapper.find('[data-testid="passkey-add"]').exists()).toBe(false)
            await wrapper.get('[data-testid="passkey-retry"]').trigger('click')
            await flushPromises()
            await wrapper.get('[data-testid="passkey-retry"]').trigger('click')
            await flushPromises()
            const body = { enrollmentId: 'pe1', response: registration }
            expect(passkeys.register.mock.calls).toEqual([[body], [body], [body]])
            expect(webauthn.createPasskey).toHaveBeenCalledOnce()
            expect(passkeys.registerOptions).toHaveBeenCalledOnce()
            expect(wrapper.find('[data-testid="passkey-add"]').exists()).toBe(true)
            expect(wrapper.get('[data-testid="passkey-message"]').text()).toBe(
                en.account.passkeys.added,
            )
        })

        it('item 4: a final refusal of a registration ends it: "Add" again', async () => {
            mfa.status.mockResolvedValue(status())
            webauthn.passkeysSupported.mockResolvedValue(true)
            passkeys.registerOptions.mockResolvedValue({
                data: { status: 'success', enrollmentId: 'pe1', options: { challenge: 'c' } },
                error: null,
            })
            webauthn.createPasskey.mockResolvedValue({ ok: true, value: { id: 'c', response: {} } })
            passkeys.register.mockResolvedValue(refused('passkey_exists', 409))
            const wrapper = await mountSection()
            await wrapper.get('[data-testid="passkey-add"]').trigger('click')
            await flushPromises()
            expect(wrapper.find('[data-testid="passkey-retry"]').exists()).toBe(false)
            expect(wrapper.find('[data-testid="passkey-add"]').exists()).toBe(true)
        })

        it.each([
            ['kept', en.account.mfa.errorRecoveryFinishKept],
            ['unknown', en.account.mfa.errorRecoveryFinishUnknown],
        ] as const)('item 5: a recovery end %s stays and says so', async (outcome, text) => {
            const recovery = { expiresAt: '2030-01-01T00:00:00.000Z', replaced: true }
            mfa.status.mockResolvedValue(
                status({ totp: { enabled: true, createdAt: 'x' }, recovery }),
            )
            lifecycle.finishRecovery.mockResolvedValue(outcome)
            const wrapper = await mountSection()
            await wrapper.get('[data-testid="mfa-recovery-finish"]').trigger('click')
            await flushPromises()
            expect(wrapper.text()).toContain(text)
            expect(push).not.toHaveBeenCalled()
            expect(store.clearUser).not.toHaveBeenCalled()
        })
    })
})
