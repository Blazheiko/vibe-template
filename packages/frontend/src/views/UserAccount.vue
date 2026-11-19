<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'
import { useStateStore } from '@/stores/state'
import { usePushStore } from '@/stores/push'
import { avatarApi, authApi, pushSubscriptionApi } from '@/utils/api'
import { buildAvatarUrl } from '@/utils/avatar-url'
import { passwordLengthProblem } from '@/utils/validate-password'
import { getErrorReason, getResponseMessage, hasResponseError } from '@/utils/response-normalizer'
import AvatarEditorModal from '@/components/AvatarEditorModal.vue'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'
import { useEventBus } from '@/utils/event-bus'
import { oauthProviderLabel } from '@/utils/oauth-provider-label'
import { useDateFormat } from '@/composables/useDateFormat'
import { useProfileSave, type ProfileChanges } from '@/composables/useProfileSave'
import { usePreferences } from '@/composables/usePreferences'
import {
    COLOR_THEMES,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    SHIPPED_LOCALE_CODES,
    resolveLanguageNativeName,
    type ColorTheme,
} from 'shared/enums'
import { allowedTimeZones, UTC_TIME_ZONE } from 'shared/utils'

defineOptions({
    name: 'UserAccount',
})

const { t } = useI18n()
const userStore = useUserStore()
const stateStore = useStateStore()
const pushStore = usePushStore()
const { websocketOpen, suspendReconnect, resumeReconnect } = useWebSocketConnection()
const eventBus = useEventBus()
const user = computed(() => userStore.user)

const fileInput = ref<HTMLInputElement | null>(null)
const showAvatarEditor = ref(false)
const selectedFile = ref<Blob | null>(null)
const avatarUrl = computed(() => buildAvatarUrl(user.value?.avatar))

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const isChangingPassword = ref(false)
const passwordMessage = ref('')

const linkPhone = ref('')
const linkPhoneCountry = ref('')
const linkPhoneCurrentPassword = ref('')
const linkPhoneCode = ref('')
const linkPhoneChallengeId = ref('')
const linkPhoneStep = ref<'start' | 'confirm'>('start')
const linkPhoneMessage = ref('')
const isLinkingPhone = ref(false)

const linkEmail = ref('')
const linkEmailCurrentPassword = ref('')
const linkEmailMessage = ref('')
const isLinkingEmail = ref(false)

// feat-097: an account created through GitHub, GitLab or Facebook gets no email until its owner
// opens the link mailed to the provider's address. Such an account has neither an email nor a
// phone (a phone-only account has a phone, and linking a phone needs a password it lacks).
const awaitsEmailConfirmation = computed(
    () => user.value !== null && !user.value.email && !user.value.phone,
)
const pendingEmailMessage = ref('')
const isResendingPendingEmail = ref(false)

const { formatDate } = useDateFormat()
const profileSave = useProfileSave()
const preferences = usePreferences()

// The swatch of each color theme; the list itself is shared/enums COLOR_THEMES (feat-232).
const COLOR_THEME_LOOK: Record<ColorTheme, { label: string; accent: string }> = {
    ocean: { label: 'Ocean', accent: '#4E7FA8' },
    mint: { label: 'Mint', accent: '#3D8A62' },
    lavender: { label: 'Lavender', accent: '#7059A6' },
    rose: { label: 'Rose', accent: '#A8627A' },
    sunset: { label: 'Sunset', accent: '#B8693C' },
    monochrome: { label: 'Mono', accent: '#5E6B78' },
}
const colorThemes = COLOR_THEMES.map((value) => ({ value, ...COLOR_THEME_LOOK[value] }))

// The shown preferences: the confirmed profile with the unsaved changes on top (Р11).
const shownPreferences = computed(() => profileSave.shown.value?.preferences ?? null)
const themeChoice = computed(() => shownPreferences.value?.theme ?? null)
const colorThemeChoice = computed(() => shownPreferences.value?.colorTheme ?? null)
const fontSizeChoice = computed(() => shownPreferences.value?.fontSize ?? null)
const fontSize = computed(() => stateStore.fontSize)

function onFontSizeInput(event: Event): void {
    void preferences.setFontSize(Number((event.target as HTMLInputElement).value))
}

const settingsMessage = computed(() => {
    const failure = profileSave.lastFailure.value
    if (failure === null) return ''
    if (failure.kind === 'rate_limited') return t('account.profile.errorRateLimited')
    return t('account.settings.errorSave')
})

// feat-232: the profile form. Only the fields that differ from the saved profile are sent.
const profileName = ref('')
const profileLocale = ref('')
const profileTimeZone = ref('')
const timeZoneSearch = ref('')
const profileFormDirty = ref(false)
const isSavingProfile = ref(false)
const profileMessage = ref('')
const nameError = ref('')

const localeOptions = SHIPPED_LOCALE_CODES.map((code) => ({
    value: code,
    label: resolveLanguageNativeName(code),
}))
const timeZones = allowedTimeZones()
const filteredTimeZones = computed(() => {
    const query = timeZoneSearch.value.trim().toLowerCase().replace(/ /g, '_')
    const matches =
        query === '' ? timeZones : timeZones.filter((zone) => zone.toLowerCase().includes(query))
    const selected = profileTimeZone.value
    // The chosen zone stays in the list, whatever the search shows.
    return selected !== '' && !matches.includes(selected) ? [selected, ...matches] : matches
})

function syncProfileForm(): void {
    const profile = userStore.profile
    if (profile === null) return
    profileName.value = profile.name
    profileLocale.value = profile.preferences.locale ?? ''
    profileTimeZone.value = profile.preferences.timeZone ?? ''
    profileFormDirty.value = false
}

watch(
    () => userStore.profile,
    () => {
        if (!profileFormDirty.value) syncProfileForm()
    },
    { immediate: true, deep: true },
)

function markProfileDirty(): void {
    profileFormDirty.value = true
    profileMessage.value = ''
}

async function saveProfile(): Promise<void> {
    const confirmed = userStore.profile
    if (confirmed === null || isSavingProfile.value) return
    nameError.value = ''
    profileMessage.value = ''

    const name = profileName.value.trim()
    if (name === '') {
        nameError.value = t('account.profile.errorNameRequired')
        return
    }
    const changes: ProfileChanges = {}
    if (name !== confirmed.name) changes.name = name
    const locale = profileLocale.value === '' ? null : profileLocale.value
    if (locale !== confirmed.preferences.locale) {
        changes.locale = locale as ProfileChanges['locale']
    }
    const timeZone = profileTimeZone.value === '' ? null : profileTimeZone.value
    if (timeZone !== confirmed.preferences.timeZone) changes.timeZone = timeZone
    if (Object.keys(changes).length === 0) {
        profileFormDirty.value = false
        profileMessage.value = t('account.profile.nothingToSave')
        return
    }

    isSavingProfile.value = true
    try {
        const outcome = await profileSave.change(changes)
        if (outcome.status === 'saved') {
            syncProfileForm()
            profileMessage.value = t('account.profile.saved')
            return
        }
        if (outcome.status === 'dropped') return
        if (outcome.kind === 'rate_limited') {
            profileMessage.value = t('account.profile.errorRateLimited')
        } else if (outcome.kind === 'validation' && changes.name !== undefined) {
            const [first = outcome.message] = outcome.messages
            nameError.value =
                outcome.messages.find((message) => message.startsWith('name')) ?? first
        } else {
            profileMessage.value = outcome.message || t('account.profile.errorSave')
        }
    } finally {
        isSavingProfile.value = false
    }
}

const pushNotificationsEnabled = ref(pushStore.isSubscribedToPush)
const isPushToggling = ref(false)
const pushStatusMessage = ref('')
const isTestingPush = ref(false)
const testPushResult = ref('')

function openFileInput(): void {
    fileInput.value?.click()
}

function handleFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    if (file.size > 10 * 1024 * 1024) {
        window.alert(t('account.avatar.errorFileSize'))
        return
    }

    if (!file.type.startsWith('image/')) {
        window.alert(t('account.avatar.errorFileType'))
        return
    }

    selectedFile.value = file
    showAvatarEditor.value = true
    input.value = ''
}

async function handleAvatarSave(blob: Blob): Promise<void> {
    showAvatarEditor.value = false
    selectedFile.value = null

    const { data, error } = await avatarApi.upload(blob)
    if (error) {
        console.error('Failed to upload avatar:', error)
        return
    }

    const currentUser = userStore.user
    if (data?.status === 'ok' && data.user && currentUser !== null) {
        userStore.setUser({
            ...currentUser,
            avatar: data.user.avatar ?? null,
        })
    }
}

function handleAvatarCancel(): void {
    showAvatarEditor.value = false
    selectedFile.value = null
}

async function deleteAvatar(): Promise<void> {
    const { data, error } = await avatarApi.delete()
    if (error) {
        console.error('Failed to delete avatar:', error)
        return
    }

    const currentUser = userStore.user
    if (data?.status === 'ok' && data.user && currentUser !== null) {
        userStore.setUser({
            ...currentUser,
            avatar: null,
        })
    }
}

async function changePassword(): Promise<void> {
    passwordMessage.value = ''

    if (passwordLengthProblem(newPassword.value) !== null) {
        passwordMessage.value = t('account.security.errorNewPasswordLength')
        return
    }

    if (newPassword.value !== confirmPassword.value) {
        passwordMessage.value = t('account.security.errorMismatch')
        return
    }

    isChangingPassword.value = true
    // feat-221: the server closes the sockets of the old session (4001) before its answer
    // brings the renewed one. A token refresh started by that close would go out with the old
    // cookie, get 401 and sign the user out; it waits for the answer instead.
    suspendReconnect()
    try {
        const payload: { currentPassword?: string; newPassword: string } = {
            newPassword: newPassword.value,
        }
        if (currentPassword.value !== '') {
            payload.currentPassword = currentPassword.value
        }

        const { data, error } = await authApi.changePassword(payload)
        if (error || hasResponseError(data) || data?.status !== 'success') {
            passwordMessage.value = getResponseMessage(
                data,
                error?.message ?? t('account.security.errorUpdate'),
            )
            return
        }

        // The password change renewed the session: the open WebSocket belonged to
        // the deleted one, so reconnect with the new token before anything else uses it.
        if (data.sessionRenewed && data.wsUrl && data.wsToken) {
            websocketOpen(data.wsUrl, data.wsToken)
        } else if (!data.sessionRenewed) {
            // Password changed, session not renewed: re-read the session (it may be
            // gone, then the app goes to the login page).
            eventBus.emit('init_app')
        }

        passwordMessage.value = t('account.security.successUpdate')
        currentPassword.value = ''
        newPassword.value = ''
        confirmPassword.value = ''
    } finally {
        // After websocketOpen: a refresh held back for the old socket is dropped by it. On a
        // failure the held-back refresh runs now, with whatever session the browser has.
        resumeReconnect()
        isChangingPassword.value = false
    }
}

async function resendVerificationEmail(): Promise<void> {
    const { data, error } = await authApi.resendVerificationEmail()
    passwordMessage.value = getResponseMessage(
        data ?? error,
        error?.message ?? t('account.emailVerification.success'),
    )
}

async function resendPendingEmailLink(): Promise<void> {
    if (isResendingPendingEmail.value) return
    isResendingPendingEmail.value = true
    pendingEmailMessage.value = ''
    try {
        const { data, error } = await authApi.resendOAuthEmailLink()
        if (!error && data?.status === 'success') {
            pendingEmailMessage.value = t('account.emailVerification.pendingSent')
            return
        }
        if (getErrorReason(data) === 'no_pending_email') {
            pendingEmailMessage.value = t('account.emailVerification.noPendingEmail')
            return
        }
        if (error?.transportCode === 409) {
            pendingEmailMessage.value = t('account.emailVerification.pendingConflict')
            return
        }
        pendingEmailMessage.value = getResponseMessage(data, error?.message ?? '')
    } finally {
        isResendingPendingEmail.value = false
    }
}

async function startPhoneLink(): Promise<void> {
    linkPhoneMessage.value = ''
    if (linkPhone.value.trim() === '' || linkPhoneCurrentPassword.value.trim() === '') {
        linkPhoneMessage.value = t('account.contactMethods.linkPhoneValidation')
        return
    }

    isLinkingPhone.value = true
    try {
        const { data, error } = await authApi.startPhoneLink({
            phone: linkPhone.value.trim(),
            currentPassword: linkPhoneCurrentPassword.value,
            defaultCountry: linkPhoneCountry.value.trim() || undefined,
        })

        if (error || hasResponseError(data) || data?.status !== 'success') {
            linkPhoneMessage.value = getResponseMessage(
                data,
                error?.message ?? t('account.contactMethods.linkPhoneError'),
            )
            return
        }

        linkPhoneChallengeId.value = data.challengeId
        linkPhoneStep.value = 'confirm'
        linkPhoneMessage.value = t('account.contactMethods.linkPhoneCodeSent')
    } finally {
        isLinkingPhone.value = false
    }
}

async function confirmPhoneLink(): Promise<void> {
    linkPhoneMessage.value = ''
    if (linkPhoneChallengeId.value === '' || linkPhoneCode.value.trim() === '') {
        linkPhoneMessage.value = t('account.contactMethods.linkPhoneCodeValidation')
        return
    }

    isLinkingPhone.value = true
    try {
        const { data, error } = await authApi.confirmPhoneLink({
            challengeId: linkPhoneChallengeId.value,
            code: linkPhoneCode.value.trim(),
        })

        if (error || hasResponseError(data) || data?.status !== 'success') {
            linkPhoneMessage.value = getResponseMessage(
                data,
                error?.message ?? t('account.contactMethods.linkPhoneError'),
            )
            return
        }

        if (data.user && userStore.user) {
            userStore.setUser({ ...userStore.user, ...data.user })
        }

        linkPhoneMessage.value = data.message || t('account.contactMethods.linkPhoneSuccess')
        linkPhone.value = ''
        linkPhoneCountry.value = ''
        linkPhoneCurrentPassword.value = ''
        linkPhoneCode.value = ''
        linkPhoneChallengeId.value = ''
        linkPhoneStep.value = 'start'
    } finally {
        isLinkingPhone.value = false
    }
}

async function startEmailLink(): Promise<void> {
    linkEmailMessage.value = ''
    if (linkEmail.value.trim() === '' || linkEmailCurrentPassword.value.trim() === '') {
        linkEmailMessage.value = t('account.contactMethods.linkEmailValidation')
        return
    }

    isLinkingEmail.value = true
    try {
        const { data, error } = await authApi.startEmailLink({
            email: linkEmail.value.trim(),
            currentPassword: linkEmailCurrentPassword.value,
        })

        linkEmailMessage.value = getResponseMessage(
            data ?? error,
            error?.message ?? t('account.contactMethods.linkEmailSuccess'),
        )
        if (!error) {
            linkEmail.value = ''
            linkEmailCurrentPassword.value = ''
        }
    } finally {
        isLinkingEmail.value = false
    }
}

function showPushStatus(message: string): void {
    pushStatusMessage.value = message
    window.setTimeout(() => {
        pushStatusMessage.value = ''
    }, 5000)
}

async function togglePushNotifications(): Promise<void> {
    const wantEnabled = pushNotificationsEnabled.value
    isPushToggling.value = true
    pushStatusMessage.value = ''
    try {
        if (wantEnabled) {
            const hasPermission = await pushStore.ensureNotificationPermission()
            if (!hasPermission) {
                pushNotificationsEnabled.value = false
                showPushStatus(t('account.settings.errorPermissionDenied'))
                return
            }

            const subscription = await pushStore.subscribeToPush()
            pushNotificationsEnabled.value = subscription !== null
            showPushStatus(
                subscription !== null
                    ? t('account.settings.successPushEnabled')
                    : t('account.settings.errorSubscribeFailed'),
            )
        } else {
            const result = await pushStore.unsubscribeFromPush()
            pushNotificationsEnabled.value = !result
            showPushStatus(
                result
                    ? t('account.settings.successPushDisabled')
                    : t('account.settings.errorUnsubscribeFailed'),
            )
        }
    } finally {
        isPushToggling.value = false
    }
}

async function sendTestPush(): Promise<void> {
    isTestingPush.value = true
    testPushResult.value = ''
    try {
        const response = await pushSubscriptionApi.testPush()
        testPushResult.value = getResponseMessage(
            response.data ?? response.error,
            response.error?.message ?? 'Failed to send test push',
        )
    } finally {
        isTestingPush.value = false
    }
}

// feat-199: the OAuth identities linked to the account. Each of them signs in whatever happens
// to the password, so the owner sees them here and can remove one. An account with a password
// confirms with it; one without must have signed in recently and keeps its last method.
interface SignInMethod {
    id: string
    provider: string
    name: string | null
    linkedAt: string
}
const signInMethods = ref<SignInMethod[]>([])
const signInMethodsLoaded = ref(false)
const accountHasPassword = ref(false)
const unlinkPassword = ref('')
const unlinkingId = ref<string | null>(null)
const signInMethodsMessage = ref('')

const UNLINK_ERRORS = new Map<string, string>([
    ['current_password_required', 'account.signInMethods.errorPasswordRequired'],
    ['current_password_incorrect', 'account.signInMethods.errorPasswordIncorrect'],
    ['recent_sign_in_required', 'account.signInMethods.errorRecentSignIn'],
    ['last_sign_in_method', 'account.signInMethods.errorLastMethod'],
])

async function loadSignInMethods(): Promise<void> {
    const { data, error } = await authApi.signInMethods()
    if (error || hasResponseError(data) || data?.status !== 'success') {
        signInMethodsMessage.value = getResponseMessage(
            data,
            error?.message ?? t('account.signInMethods.errorLoad'),
        )
        return
    }
    signInMethods.value = data.methods
    accountHasPassword.value = data.hasPassword
    signInMethodsLoaded.value = true
}

async function unlinkSignInMethod(method: SignInMethod): Promise<void> {
    signInMethodsMessage.value = ''
    if (accountHasPassword.value && unlinkPassword.value === '') {
        signInMethodsMessage.value = t('account.signInMethods.errorPasswordRequired')
        return
    }

    unlinkingId.value = method.id
    try {
        const { data, error } = await authApi.unlinkSignInMethod({
            id: method.id,
            ...(accountHasPassword.value ? { currentPassword: unlinkPassword.value } : {}),
        })
        if (error || hasResponseError(data) || data?.status !== 'success') {
            const known = UNLINK_ERRORS.get(getErrorReason(data) ?? '')
            signInMethodsMessage.value =
                known !== undefined
                    ? t(known)
                    : getResponseMessage(
                          data,
                          error?.message ?? t('account.signInMethods.errorUnlink'),
                      )
            return
        }
        unlinkPassword.value = ''
        signInMethodsMessage.value = t('account.signInMethods.unlinked', {
            provider: oauthProviderLabel(method.provider),
        })
        await loadSignInMethods()
    } finally {
        unlinkingId.value = null
    }
}

void pushStore.ensurePushSubscriptionsLoaded()
void loadSignInMethods()

watch(
    () => pushStore.isSubscribedToPush,
    (newValue) => {
        pushNotificationsEnabled.value = newValue
    },
)
</script>

<template>
    <div class="account-page">
        <section class="panel profile-panel">
            <button class="avatar-button" type="button" @click="openFileInput">
                <img v-if="avatarUrl" :src="avatarUrl" alt="Avatar" class="avatar-image" />
                <span v-else class="avatar-fallback">{{ user?.name?.charAt(0) || 'U' }}</span>
            </button>
            <input
                ref="fileInput"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                class="file-input-hidden"
                @change="handleFileSelect"
            />
            <div class="profile-copy">
                <h1>{{ user?.name || 'Account' }}</h1>
                <p>{{ user?.email || user?.phone }}</p>
                <p v-if="user?.email && !user.emailVerified" class="status-warning">
                    {{ t('account.emailVerification.notVerified') }}
                    <button type="button" @click="resendVerificationEmail">
                        {{ t('account.emailVerification.resend') }}
                    </button>
                </p>
                <p v-if="awaitsEmailConfirmation" class="status-warning pending-email">
                    {{ t('account.emailVerification.pending') }}
                    <button
                        type="button"
                        :disabled="isResendingPendingEmail"
                        @click="resendPendingEmailLink"
                    >
                        {{ t('account.emailVerification.resendPending') }}
                    </button>
                </p>
                <p v-if="pendingEmailMessage" class="form-message" role="status">
                    {{ pendingEmailMessage }}
                </p>
            </div>
            <button v-if="avatarUrl" class="secondary-button" type="button" @click="deleteAvatar">
                {{ t('account.avatar.delete') }}
            </button>
        </section>

        <section class="panel" data-testid="profile-form">
            <h2>{{ t('account.profile.title') }}</h2>
            <form class="profile-form" novalidate @submit.prevent="saveProfile">
                <label class="field">
                    <span>{{ t('account.profile.name') }}</span>
                    <input
                        v-model="profileName"
                        name="profile-name"
                        autocomplete="name"
                        maxlength="100"
                        :aria-invalid="nameError !== ''"
                        aria-describedby="profile-name-error"
                        @input="markProfileDirty"
                    />
                    <small
                        v-if="nameError"
                        id="profile-name-error"
                        class="field-error"
                        data-testid="profile-name-error"
                        role="alert"
                    >
                        {{ nameError }}
                    </small>
                </label>
                <label class="field">
                    <span>{{ t('account.profile.language') }}</span>
                    <select
                        v-model="profileLocale"
                        name="profile-locale"
                        @change="markProfileDirty"
                    >
                        <option value="">{{ t('account.profile.asBrowser') }}</option>
                        <option
                            v-for="option in localeOptions"
                            :key="option.value"
                            :value="option.value"
                        >
                            {{ option.label }}
                        </option>
                    </select>
                </label>
                <label class="field">
                    <span>{{ t('account.profile.timeZone') }}</span>
                    <input
                        v-model="timeZoneSearch"
                        type="search"
                        name="profile-time-zone-search"
                        :placeholder="t('account.profile.timeZoneSearch')"
                    />
                    <select
                        v-model="profileTimeZone"
                        name="profile-time-zone"
                        @change="markProfileDirty"
                    >
                        <option value="">{{ t('account.profile.asBrowser') }}</option>
                        <option v-for="zone in filteredTimeZones" :key="zone" :value="zone">
                            {{ zone === UTC_TIME_ZONE ? 'UTC' : zone.replace(/_/g, ' ') }}
                        </option>
                    </select>
                </label>
                <button class="primary-button" type="submit" :disabled="isSavingProfile">
                    {{ t('account.profile.save') }}
                </button>
                <p v-if="profileMessage" class="form-message" role="status">{{ profileMessage }}</p>
            </form>
        </section>

        <section class="panel">
            <h2>{{ t('account.security.title') }}</h2>
            <div class="form-grid">
                <input
                    v-model="currentPassword"
                    type="password"
                    name="current-password"
                    autocomplete="current-password"
                    :placeholder="t('account.security.currentPassword')"
                />
                <input
                    v-model="newPassword"
                    type="password"
                    name="new-password"
                    autocomplete="new-password"
                    :placeholder="t('account.security.newPassword')"
                />
                <input
                    v-model="confirmPassword"
                    type="password"
                    name="confirm-password"
                    autocomplete="new-password"
                    :placeholder="t('account.security.confirmPassword')"
                />
            </div>
            <button class="primary-button" :disabled="isChangingPassword" @click="changePassword">
                {{ t('account.security.updatePassword') }}
            </button>
            <p v-if="passwordMessage" class="form-message">{{ passwordMessage }}</p>
        </section>

        <section class="panel" data-testid="sign-in-methods">
            <h2>{{ t('account.signInMethods.title') }}</h2>
            <p class="form-message">{{ t('account.signInMethods.help') }}</p>
            <p v-if="signInMethodsLoaded && signInMethods.length === 0" class="form-message">
                {{ t('account.signInMethods.empty') }}
            </p>
            <ul v-if="signInMethods.length > 0" class="sign-in-methods">
                <li
                    v-for="method in signInMethods"
                    :key="method.id"
                    class="sign-in-method"
                    :data-provider="method.provider"
                >
                    <span class="sign-in-method-name">
                        <strong>{{ oauthProviderLabel(method.provider) }}</strong>
                        <span v-if="method.name"> · {{ method.name }}</span>
                    </span>
                    <span class="sign-in-method-date">
                        {{
                            t('account.signInMethods.linkedAt', {
                                date: formatDate(method.linkedAt),
                            })
                        }}
                    </span>
                    <button
                        class="secondary-button"
                        :disabled="unlinkingId !== null"
                        @click="unlinkSignInMethod(method)"
                    >
                        {{ t('account.signInMethods.unlink') }}
                    </button>
                </li>
            </ul>
            <div v-if="signInMethods.length > 0 && accountHasPassword" class="form-grid">
                <input
                    v-model="unlinkPassword"
                    type="password"
                    name="unlink-current-password"
                    autocomplete="current-password"
                    :placeholder="t('account.signInMethods.currentPassword')"
                />
            </div>
            <p
                v-if="signInMethods.length > 0 && signInMethodsLoaded && !accountHasPassword"
                class="form-message"
            >
                {{ t('account.signInMethods.noPasswordHint') }}
            </p>
            <p v-if="signInMethodsMessage" class="form-message" role="status">
                {{ signInMethodsMessage }}
            </p>
        </section>

        <section class="panel">
            <h2>{{ t('account.contactMethods.title') }}</h2>
            <div class="form-grid">
                <input
                    v-model="linkPhone"
                    type="tel"
                    name="phone"
                    autocomplete="tel"
                    :placeholder="t('account.contactMethods.phone')"
                />
                <input
                    v-model="linkPhoneCountry"
                    name="phone-country"
                    autocomplete="country"
                    placeholder="US"
                />
                <input
                    v-model="linkPhoneCurrentPassword"
                    type="password"
                    name="link-phone-current-password"
                    autocomplete="current-password"
                    :placeholder="t('account.security.currentPassword')"
                />
                <input
                    v-if="linkPhoneStep === 'confirm'"
                    v-model="linkPhoneCode"
                    name="phone-code"
                    autocomplete="one-time-code"
                    inputmode="numeric"
                    :placeholder="t('account.contactMethods.code')"
                />
            </div>
            <button
                class="primary-button"
                :disabled="isLinkingPhone"
                @click="linkPhoneStep === 'start' ? startPhoneLink() : confirmPhoneLink()"
            >
                {{
                    linkPhoneStep === 'start'
                        ? t('account.contactMethods.linkPhone')
                        : t('account.contactMethods.confirmPhone')
                }}
            </button>
            <p v-if="linkPhoneMessage" class="form-message">{{ linkPhoneMessage }}</p>

            <div class="form-grid form-grid--spaced">
                <input
                    v-model="linkEmail"
                    type="email"
                    name="email"
                    autocomplete="email"
                    :placeholder="t('account.contactMethods.email')"
                />
                <input
                    v-model="linkEmailCurrentPassword"
                    type="password"
                    name="link-email-current-password"
                    autocomplete="current-password"
                    :placeholder="t('account.security.currentPassword')"
                />
            </div>
            <button class="secondary-button" :disabled="isLinkingEmail" @click="startEmailLink">
                {{ t('account.contactMethods.linkEmail') }}
            </button>
            <p v-if="linkEmailMessage" class="form-message">{{ linkEmailMessage }}</p>
        </section>

        <section class="panel" data-testid="preferences">
            <h2>{{ t('account.settings.title') }}</h2>
            <fieldset class="setting-group">
                <legend>{{ t('account.settings.theme') }}</legend>
                <label class="setting-choice">
                    <input
                        type="radio"
                        name="theme"
                        value="system"
                        :checked="themeChoice === null"
                        @change="preferences.setTheme(null)"
                    />
                    {{ t('account.settings.themeSystem') }}
                </label>
                <label class="setting-choice">
                    <input
                        type="radio"
                        name="theme"
                        value="light"
                        :checked="themeChoice === 'light'"
                        @change="preferences.setTheme('light')"
                    />
                    {{ t('account.settings.themeLight') }}
                </label>
                <label class="setting-choice">
                    <input
                        type="radio"
                        name="theme"
                        value="dark"
                        :checked="themeChoice === 'dark'"
                        @change="preferences.setTheme('dark')"
                    />
                    {{ t('account.settings.themeDark') }}
                </label>
            </fieldset>
            <div class="setting-row">
                <label for="font-size-range">{{ t('account.settings.fontSize') }}</label>
                <input
                    id="font-size-range"
                    :value="fontSize"
                    type="range"
                    name="font-size"
                    :min="FONT_SIZE_MIN"
                    :max="FONT_SIZE_MAX"
                    step="1"
                    @input="onFontSizeInput"
                />
                <button
                    class="secondary-button"
                    type="button"
                    data-testid="font-size-default"
                    :disabled="fontSizeChoice === null"
                    @click="preferences.setFontSize(null)"
                >
                    {{ t('account.settings.default') }}
                </button>
            </div>
            <div class="theme-grid">
                <button
                    v-for="theme in colorThemes"
                    :key="theme.value"
                    type="button"
                    class="theme-button"
                    :data-color-theme="theme.value"
                    :aria-pressed="colorThemeChoice === theme.value"
                    :style="{ '--theme-color': theme.accent }"
                    @click="preferences.setColorTheme(theme.value)"
                >
                    {{ theme.label }}
                </button>
                <button
                    type="button"
                    class="theme-button"
                    data-testid="color-theme-default"
                    :aria-pressed="colorThemeChoice === null"
                    @click="preferences.setColorTheme(null)"
                >
                    {{ t('account.settings.default') }}
                </button>
            </div>
            <p v-if="settingsMessage" class="form-message" role="status">{{ settingsMessage }}</p>
        </section>

        <section class="panel">
            <h2>{{ t('account.settings.pushNotifications') }}</h2>
            <label class="setting-row">
                <span>{{ t('account.settings.enablePushNotifications') }}</span>
                <input
                    v-model="pushNotificationsEnabled"
                    type="checkbox"
                    :disabled="isPushToggling"
                    @change="togglePushNotifications"
                />
            </label>
            <button class="secondary-button" :disabled="isTestingPush" @click="sendTestPush">
                {{ t('account.settings.testPush') }}
            </button>
            <p v-if="pushStatusMessage" class="form-message">{{ pushStatusMessage }}</p>
            <p v-if="testPushResult" class="form-message">{{ testPushResult }}</p>
        </section>

        <AvatarEditorModal
            v-if="showAvatarEditor && selectedFile"
            :image-file="selectedFile"
            @save="handleAvatarSave"
            @cancel="handleAvatarCancel"
        />
    </div>
</template>

<style scoped>
.account-page {
    width: min(920px, calc(100% - 32px));
    margin: 24px auto;
    display: grid;
    gap: 16px;
}

.panel {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 20px;
}

.profile-panel {
    display: flex;
    align-items: center;
    gap: 16px;
}

.avatar-button {
    width: 88px;
    height: 88px;
    border: 0;
    border-radius: 50%;
    overflow: hidden;
    padding: 0;
    background: var(--accent-color);
    color: #fff;
    cursor: pointer;
}

.avatar-image,
.avatar-fallback {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    object-fit: cover;
    font-size: 2rem;
    font-weight: 700;
}

.profile-copy {
    flex: 1;
}

.profile-copy h1,
.panel h2 {
    margin: 0 0 8px;
}

.profile-copy p,
.form-message {
    margin: 0;
    color: var(--text-secondary);
}

.status-warning {
    color: var(--warning-color, #a16207);
}

.file-input-hidden {
    display: none;
}

.sign-in-methods {
    list-style: none;
    margin: 12px 0;
    padding: 0;
    display: grid;
    gap: 8px;
}

.sign-in-method {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
}

.sign-in-method-name {
    flex: 1 1 200px;
    min-width: 0;
    overflow-wrap: anywhere;
}

.sign-in-method-date {
    color: var(--text-secondary);
}

.form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 12px;
}

.form-grid--spaced {
    margin-top: 20px;
}

input {
    min-height: 40px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0 12px;
    background: var(--bg-primary);
    color: var(--text-primary);
}

.primary-button,
.secondary-button,
.theme-button,
.status-warning button {
    min-height: 36px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0 12px;
    cursor: pointer;
}

.primary-button {
    background: var(--accent-color);
    color: #fff;
    border-color: var(--accent-color);
}

.secondary-button,
.theme-button,
.status-warning button {
    background: var(--bg-primary);
    color: var(--text-primary);
}

.setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 44px;
}

.profile-form {
    display: grid;
    gap: 12px;
    max-width: 480px;
}

.field {
    display: grid;
    gap: 6px;
}

.field select {
    min-height: 40px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 0 10px;
    background: var(--bg-primary);
    color: var(--text-primary);
}

.field-error {
    color: var(--danger-color, #c0392b);
}

.setting-group {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    border: 0;
    padding: 0;
    margin: 0 0 12px;
}

.setting-choice {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.setting-choice input {
    width: auto;
    min-height: 0;
}

.theme-button[aria-pressed='true'] {
    outline: 2px solid var(--theme-color, var(--accent-color));
    outline-offset: 2px;
}

.theme-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.theme-button::before {
    content: '';
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 6px;
    background: var(--theme-color);
}

@media (max-width: 640px) {
    .profile-panel {
        align-items: flex-start;
        flex-direction: column;
    }
}
</style>
