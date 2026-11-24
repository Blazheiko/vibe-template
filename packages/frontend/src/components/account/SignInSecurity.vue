<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { withReauth } from '@/composables/useReauth'
import { useSessionLifecycle } from '@/composables/useSessionLifecycle'
import { useUserStore } from '@/stores/user'
import { mfaApi } from '@/utils/api'
import { useEventBus } from '@/utils/event-bus'
import { getErrorReason } from '@/utils/response-normalizer'
import type { StaffMfaReason } from '@/utils/staff-mfa'
import ConfirmDialog from './ConfirmDialog.vue'
import PasskeyList from './PasskeyList.vue'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7, Р8, Р15): the second factors of the account. The
// TOTP setup draws its QR code in the browser (the secret never leaves for another service);
// recovery codes are shown once. In a recovery session this is the whole page: replace the
// lost factor, get new codes, finish, sign in again.
const props = withDefaults(
    defineProps<{
        /** feat-247: the account holds a staff role (the staff MFA rule applies to it). */
        staff?: boolean
        /** feat-247: why the admin area sent this session here, if it did. */
        staffReason?: StaffMfaReason | null
    }>(),
    { staff: false, staffReason: null },
)
const { t } = useI18n()
const userStore = useUserStore()
const eventBus = useEventBus()
const sessionLifecycle = useSessionLifecycle()

interface Status {
    totp: { enabled: boolean; createdAt: string | null }
    passkeys: number
    recoveryCodesRemaining: number
    recoveryContact: boolean
    recovery: { expiresAt: string; replaced: boolean } | null
    /** feat-248: the factor a staff role needs on this deployment; null without one. */
    staffFactor: 'any' | 'passkey' | null
}

const status = ref<Status | null>(null)
const message = ref('')
const busy = ref(false)
const setup = ref<{ enrollmentId: string; secret: string; qr: string } | null>(null)
const setupCode = ref('')
const codes = ref<string[] | null>(null)
const confirmingDisable = ref(false)

const inRecovery = computed(() => status.value?.recovery !== null && status.value !== null)
// feat-246: a passkey is a second factor too.
const mfaEnabled = computed(
    () => status.value !== null && (status.value.totp.enabled || status.value.passkeys > 0),
)
/**
 * feat-247 (Р10): what a staff account must do for the admin area. Without a factor: set one up
 * (also shown unasked, as a banner). With one, refused for the session: sign in again with it.
 * feat-248 (Д11): with MFA_STAFF_FACTOR=passkey only a passkey counts: a staff account without
 * one sees the banner unasked, and signs in again with the passkey.
 */
type StaffNotice = 'factor' | 'passkey' | 'signIn' | 'signInPasskey'
const STAFF_NOTICE_TEXT: Record<StaffNotice, string> = {
    factor: 'account.mfa.staffFactorRequired',
    passkey: 'account.mfa.staffPasskeyRequired',
    signIn: 'account.mfa.staffSessionRequired',
    signInPasskey: 'account.mfa.staffPasskeySessionRequired',
}
const passkeyMode = computed(() => status.value?.staffFactor === 'passkey')
const staffNotice = computed<StaffNotice | null>(() => {
    if (status.value === null || inRecovery.value) return null
    if (passkeyMode.value && status.value.passkeys === 0) return 'passkey'
    if (!mfaEnabled.value) return props.staff || props.staffReason !== null ? 'factor' : null
    if (props.staffReason === null) return null
    return passkeyMode.value ? 'signInPasskey' : 'signIn'
})
const signInForAdmin = (): void => {
    eventBus.emit('sign_in_again', '/admin')
}
const showCodes = (next: string[]): void => {
    codes.value = next
}

const REASONS = new Map<string, string>([
    ['recovery_contact_required', 'account.mfa.errorContact'],
    ['invalid_code', 'account.mfa.errorCode'],
    ['enrollment_not_found', 'account.mfa.errorSetupExpired'],
    ['recovery_session', 'account.mfa.errorRecoveryOrder'],
    // feat-256: the factors changed since the setup (another session turned MFA on).
    ['reauth_required', 'account.mfa.errorSetupRestart'],
    ['sign_in_again_required', 'account.mfa.errorSetupRestart'],
    // feat-248 (Р12): the factor a staff role needs stays.
    ['mfa_required_for_role', 'account.mfa.errorStaffFactor'],
])

const explain = (data: unknown): string =>
    t(REASONS.get(getErrorReason(data) ?? '') ?? 'account.mfa.errorGeneric')

const signInAgain = (): void => {
    eventBus.emit('sign_in_again', '/account')
}

async function load(): Promise<void> {
    const { data } = await mfaApi.status()
    if (data?.status === 'success') {
        status.value = {
            totp: data.totp,
            passkeys: data.passkeys,
            recoveryCodesRemaining: data.recoveryCodesRemaining,
            recoveryContact: data.recoveryContact,
            recovery: data.recovery,
            staffFactor: data.staffFactor,
        }
        userStore.setRecovery(data.recovery)
    }
}

async function startSetup(): Promise<void> {
    message.value = ''
    busy.value = true
    try {
        const outcome = await withReauth(() => mfaApi.totpSetup())
        if (outcome.signInAgain) {
            signInAgain()
            return
        }
        const { data } = outcome.response
        if (data?.status !== 'success') {
            message.value = explain(data)
            return
        }
        // Loaded only here: the QR library stays out of the main bundle (ADR 0005).
        const { toDataURL } = await import('qrcode')
        setup.value = {
            enrollmentId: data.enrollmentId,
            secret: data.secret,
            qr: await toDataURL(data.otpauthUri, { margin: 1, width: 200 }),
        }
        setupCode.value = ''
    } finally {
        busy.value = false
    }
}

/**
 * feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 3): refusals after which this setup can
 * never be confirmed (its kept proof no longer admits a factor, it lapsed, the session ended):
 * the form goes back to "Set up", which asks for the proof the account needs now. A wrong code or
 * a failure with an unknown outcome keeps the setup and the code, so the same request goes again.
 */
const SETUP_RESTART_REASONS = new Set([
    'reauth_required',
    'sign_in_again_required',
    'enrollment_not_found',
    'recovery_session',
    'session_revoked',
])

async function confirmSetup(): Promise<void> {
    if (setup.value === null) return
    message.value = ''
    busy.value = true
    try {
        const { data } = await mfaApi.totpConfirm({
            enrollmentId: setup.value.enrollmentId,
            code: setupCode.value.replace(/\s/g, ''),
        })
        if (data?.status !== 'success') {
            message.value = explain(data)
            if (SETUP_RESTART_REASONS.has(getErrorReason(data) ?? '')) setup.value = null
            return
        }
        setup.value = null
        codes.value = data.recoveryCodes
        message.value = t('account.mfa.enabled')
        await load()
    } finally {
        busy.value = false
    }
}

async function disable(): Promise<void> {
    confirmingDisable.value = false
    message.value = ''
    busy.value = true
    try {
        const outcome = await withReauth(() => mfaApi.totpDisable())
        if (outcome.signInAgain) {
            signInAgain()
            return
        }
        const { data } = outcome.response
        message.value = data?.status === 'success' ? t('account.mfa.disabled') : explain(data)
        await load()
    } finally {
        busy.value = false
    }
}

async function regenerate(): Promise<void> {
    message.value = ''
    busy.value = true
    try {
        const outcome = await withReauth(() => mfaApi.regenerateRecoveryCodes())
        if (outcome.signInAgain) {
            signInAgain()
            return
        }
        const { data } = outcome.response
        if (data?.status !== 'success') {
            message.value = explain(data)
            return
        }
        codes.value = data.recoveryCodes
        await load()
    } finally {
        busy.value = false
    }
}

async function copyCodes(): Promise<void> {
    if (codes.value === null) return
    try {
        await navigator.clipboard.writeText(codes.value.join('\n'))
        message.value = t('account.mfa.codesCopied')
    } catch {
        message.value = t('account.mfa.errorGeneric')
    }
}

const codesFile = computed(() =>
    codes.value === null
        ? ''
        : `data:text/plain;charset=utf-8,${encodeURIComponent(codes.value.join('\n') + '\n')}`,
)

/**
 * feat-256 (docs/plan/mfa-review-fixes-7-plan.md, item 5): /login only once the end of the
 * recovery session is confirmed; a session the server kept, or an outcome it could not confirm,
 * stays here, signed in, and says so.
 */
async function finishRecovery(): Promise<void> {
    message.value = ''
    busy.value = true
    try {
        const outcome = await sessionLifecycle.finishRecovery()
        if (outcome === 'kept') message.value = t('account.mfa.errorRecoveryFinishKept')
        else if (outcome === 'unknown') message.value = t('account.mfa.errorRecoveryFinishUnknown')
    } finally {
        busy.value = false
    }
}

onMounted(() => {
    void load()
})
</script>

<template>
    <section class="panel" data-testid="mfa-settings">
        <h2>{{ t('account.mfa.title') }}</h2>

        <div v-if="inRecovery" class="mfa-recovery" role="status" data-testid="mfa-recovery">
            <p>{{ t('account.mfa.recoveryIntro') }}</p>
            <ol>
                <li>{{ t('account.mfa.recoveryStep1') }}</li>
                <li>{{ t('account.mfa.recoveryStep2') }}</li>
                <li>{{ t('account.mfa.recoveryStep3') }}</li>
            </ol>
        </div>

        <div
            v-if="staffNotice !== null"
            class="mfa-staff"
            role="alert"
            data-testid="staff-mfa-notice"
        >
            <p>{{ t(STAFF_NOTICE_TEXT[staffNotice]) }}</p>
            <button
                v-if="staffNotice === 'signIn' || staffNotice === 'signInPasskey'"
                class="primary-button"
                type="button"
                data-testid="staff-mfa-sign-in"
                @click="signInForAdmin"
            >
                {{ t('account.mfa.staffSignIn') }}
            </button>
        </div>

        <p v-if="status === null" class="form-message">{{ t('account.mfa.loading') }}</p>
        <template v-else>
            <p class="form-message" data-testid="mfa-totp-state">
                {{ status.totp.enabled ? t('account.mfa.totpOn') : t('account.mfa.totpOff') }}
            </p>
            <p
                v-if="!status.totp.enabled && !status.recoveryContact"
                class="form-message"
                data-testid="mfa-need-contact"
            >
                {{ t('account.mfa.errorContact') }}
            </p>

            <div v-if="setup !== null" class="mfa-setup" data-testid="mfa-setup">
                <p>{{ t('account.mfa.scan') }}</p>
                <img :src="setup.qr" :alt="t('account.mfa.qrAlt')" width="200" height="200" />
                <p>
                    {{ t('account.mfa.manual') }}
                    <code data-testid="mfa-secret">{{ setup.secret }}</code>
                </p>
                <input
                    v-model="setupCode"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="10"
                    :placeholder="t('account.mfa.codePlaceholder')"
                    data-testid="mfa-setup-code"
                />
                <button
                    class="primary-button"
                    type="button"
                    :disabled="busy"
                    data-testid="mfa-setup-confirm"
                    @click="confirmSetup"
                >
                    {{ t('account.mfa.confirm') }}
                </button>
            </div>
            <div v-else class="mfa-actions">
                <button
                    class="secondary-button"
                    type="button"
                    :disabled="busy || (!status.totp.enabled && !status.recoveryContact)"
                    data-testid="mfa-setup-start"
                    @click="startSetup"
                >
                    {{ status.totp.enabled ? t('account.mfa.replace') : t('account.mfa.turnOn') }}
                </button>
                <button
                    v-if="mfaEnabled && (!inRecovery || status.recovery?.replaced)"
                    class="secondary-button"
                    type="button"
                    :disabled="busy"
                    data-testid="mfa-regenerate"
                    @click="regenerate"
                >
                    {{ t('account.mfa.newCodes') }}
                </button>
                <button
                    v-if="status.totp.enabled && !inRecovery"
                    class="danger-button"
                    type="button"
                    :disabled="busy"
                    data-testid="mfa-disable"
                    @click="confirmingDisable = true"
                >
                    {{ t('account.mfa.turnOff') }}
                </button>
            </div>

            <PasskeyList
                :can-add="status.recoveryContact || mfaEnabled"
                :in-recovery="inRecovery"
                :recovery-replaced="status.recovery?.replaced === true"
                @changed="load"
                @codes="showCodes"
            />

            <p v-if="mfaEnabled" class="form-message" data-testid="mfa-codes-left">
                {{ t('account.mfa.codesLeft', { count: status.recoveryCodesRemaining }) }}
                <template v-if="status.recoveryCodesRemaining <= 2">
                    {{ t('account.mfa.codesLow') }}
                </template>
            </p>

            <div v-if="codes !== null" class="mfa-codes" data-testid="mfa-codes">
                <p>{{ t('account.mfa.codesOnce') }}</p>
                <ul>
                    <li v-for="code in codes" :key="code">
                        <code>{{ code }}</code>
                    </li>
                </ul>
                <button class="secondary-button" type="button" @click="copyCodes">
                    {{ t('account.mfa.copy') }}
                </button>
                <a class="secondary-button" :href="codesFile" download="recovery-codes.txt">
                    {{ t('account.mfa.download') }}
                </a>
            </div>

            <button
                v-if="inRecovery"
                class="primary-button"
                type="button"
                :disabled="busy"
                data-testid="mfa-recovery-finish"
                @click="finishRecovery"
            >
                {{ t('account.mfa.finish') }}
            </button>
        </template>

        <p v-if="message" class="form-message" role="status" data-testid="mfa-message">
            {{ message }}
        </p>

        <ConfirmDialog
            v-if="confirmingDisable"
            :title="t('account.mfa.disableTitle')"
            :text="t('account.mfa.disableText')"
            :confirm-label="t('account.mfa.turnOff')"
            :cancel-label="t('account.reauth.cancel')"
            @confirm="disable"
            @cancel="confirmingDisable = false"
        />
    </section>
</template>

<style scoped>
.mfa-actions,
.mfa-setup,
.mfa-codes {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
}

.mfa-setup,
.mfa-codes {
    flex-direction: column;
    align-items: flex-start;
}

.mfa-codes ul {
    columns: 2;
    padding-left: 16px;
}

.mfa-staff {
    border: 1px solid var(--warning-color, var(--border-color));
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 12px;
}

.mfa-recovery {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 12px;
}
</style>
