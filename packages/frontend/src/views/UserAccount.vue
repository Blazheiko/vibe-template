<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'
import { useStateStore } from '@/stores/state'
import { avatarApi, authApi, pushSubscriptionApi } from '@/utils/api'
import { buildAvatarUrl } from '@/utils/avatar-url'
import { passwordLengthProblem } from '@/utils/validate-password'
import { getResponseMessage, hasResponseError } from '@/utils/response-normalizer'
import AvatarEditorModal from '@/components/AvatarEditorModal.vue'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'
import { useEventBus } from '@/utils/event-bus'

defineOptions({
    name: 'UserAccount',
})

const { t } = useI18n()
const userStore = useUserStore()
const stateStore = useStateStore()
const { websocketOpen } = useWebSocketConnection()
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

const darkMode = ref(stateStore.darkMode)
const fontSize = computed({
    get: () => stateStore.fontSize,
    set: (value: number) => {
        stateStore.setFontSize(value)
    },
})
const colorThemes = [
    { value: 'ocean', label: 'Ocean', accent: '#4E7FA8' },
    { value: 'mint', label: 'Mint', accent: '#3D8A62' },
    { value: 'lavender', label: 'Lavender', accent: '#7059A6' },
    { value: 'rose', label: 'Rose', accent: '#A8627A' },
    { value: 'sunset', label: 'Sunset', accent: '#B8693C' },
    { value: 'monochrome', label: 'Mono', accent: '#5E6B78' },
]

const pushNotificationsEnabled = ref(stateStore.isSubscribedToPush)
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

function toggleDarkMode(): void {
    darkMode.value = !darkMode.value
    stateStore.setDarkMode(darkMode.value)
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
            const hasPermission = await stateStore.ensureNotificationPermission()
            if (!hasPermission) {
                pushNotificationsEnabled.value = false
                showPushStatus(t('account.settings.errorPermissionDenied'))
                return
            }

            const subscription = await stateStore.subscribeToPush()
            pushNotificationsEnabled.value = subscription !== null
            showPushStatus(
                subscription !== null
                    ? t('account.settings.successPushEnabled')
                    : t('account.settings.errorSubscribeFailed'),
            )
        } else {
            const result = await stateStore.unsubscribeFromPush()
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

void stateStore.ensurePushSubscriptionsLoaded()

watch(
    () => stateStore.isSubscribedToPush,
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
            </div>
            <button v-if="avatarUrl" class="secondary-button" type="button" @click="deleteAvatar">
                {{ t('account.avatar.delete') }}
            </button>
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

        <section class="panel">
            <h2>{{ t('account.settings.title') }}</h2>
            <label class="setting-row">
                <span>{{ t('account.settings.darkMode') }}</span>
                <input type="checkbox" :checked="darkMode" @change="toggleDarkMode" />
            </label>
            <label class="setting-row">
                <span>{{ t('account.settings.fontSize') }}</span>
                <input v-model.number="fontSize" type="range" min="14" max="20" step="1" />
            </label>
            <div class="theme-grid">
                <button
                    v-for="theme in colorThemes"
                    :key="theme.value"
                    type="button"
                    class="theme-button"
                    :style="{ '--theme-color': theme.accent }"
                    @click="stateStore.setColorTheme(theme.value)"
                >
                    {{ theme.label }}
                </button>
            </div>
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
