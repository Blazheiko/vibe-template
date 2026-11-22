<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SessionView } from 'shared'
import ConfirmDialog from '@/components/account/ConfirmDialog.vue'
import { useActiveSessions } from '@/composables/useActiveSessions'
import { useDateFormat } from '@/composables/useDateFormat'
import { oauthProviderLabel } from '@/utils/oauth-provider-label'

// feat-233: the active sessions of the account (Р7–Р13). The section has the `#sessions` anchor
// the sign-in mail and push link to.

const { t } = useI18n()
const { formatDate, formatDateTime } = useDateFormat()
const sessions = useActiveSessions()

const HOUR_MS = 60 * 60_000

/** Accurate to the hour (Р4): "less than an hour ago", "N h ago", "yesterday", a date. */
const lastSeenLabel = (iso: string | null, now = Date.now()): string => {
    if (iso === null) return t('account.sessions.lastSeenUnknown')
    const elapsed = now - new Date(iso).getTime()
    let when: string
    if (!Number.isFinite(elapsed) || elapsed < HOUR_MS) {
        when = t('account.sessions.lastSeenLessThanHour')
    } else if (elapsed < 24 * HOUR_MS) {
        when = t('account.sessions.lastSeenHours', { n: Math.floor(elapsed / HOUR_MS) })
    } else if (elapsed < 48 * HOUR_MS) {
        when = t('account.sessions.lastSeenYesterday')
    } else {
        when = formatDate(iso)
    }
    return t('account.sessions.lastSeen', { when })
}

const deviceLabel = (session: SessionView): string => {
    const browser =
        session.browser === 'unknown' ? t('account.sessions.unknownBrowser') : session.browser
    const os = session.os === 'unknown' ? t('account.sessions.unknownOs') : session.os
    return `${browser} · ${os}`
}

const methodLabel = (session: SessionView): string => {
    if (session.method === 'oauth') {
        return oauthProviderLabel(session.provider ?? '')
    }
    if (session.method === 'passkey') return t('account.sessions.methodPasskey')
    return session.method === 'register'
        ? t('account.sessions.methodRegister')
        : t('account.sessions.methodPassword')
}

const ICONS: Record<SessionView['deviceType'], string> = {
    desktop: 'M4 5h16v10H4zM2 17h20v2H2z',
    mobile: 'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm3 17h2',
    tablet: 'M5 2h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm6 17h2',
    unknown: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 12v.01M12 7v5',
}

type Pending = { kind: 'one'; session: SessionView } | { kind: 'others' }
const pending = ref<Pending | null>(null)

const confirmText = computed(() => {
    const value = pending.value
    if (value === null) return ''
    return value.kind === 'one'
        ? t('account.sessions.confirmEndText', { device: deviceLabel(value.session) })
        : t('account.sessions.confirmEndOthersText')
})

const confirm = async (): Promise<void> => {
    const value = pending.value
    pending.value = null
    if (value === null) return
    if (value.kind === 'one') await sessions.revoke(value.session.id)
    else await sessions.revokeOthers()
}

const noticeText = computed(() =>
    sessions.notice.value === null ? '' : t(`account.sessions.${sessions.notice.value}`),
)
const noticeIsError = computed(
    () => sessions.notice.value === 'errorEnd' || sessions.notice.value === 'tryAgain',
)

const all = computed(() =>
    sessions.current.value === null
        ? sessions.others.value
        : [sessions.current.value, ...sessions.others.value],
)
</script>

<template>
    <section id="sessions" class="panel" data-testid="active-sessions">
        <h2>{{ t('account.sessions.title') }}</h2>
        <p class="hint">{{ t('account.sessions.help') }}</p>

        <p v-if="!sessions.loaded.value && sessions.loading.value" class="form-message">
            {{ t('account.sessions.loading') }}
        </p>
        <div
            v-if="sessions.error.value !== null"
            class="form-message status-warning"
            role="alert"
            data-testid="sessions-error"
        >
            {{
                sessions.error.value === 'unavailable'
                    ? t('account.sessions.errorUnavailable')
                    : t('account.sessions.errorLoad')
            }}
            <button class="secondary-button" type="button" @click="sessions.load()">
                {{ t('account.sessions.retry') }}
            </button>
        </div>

        <ul v-if="sessions.loaded.value" class="session-list">
            <li
                v-for="session in all"
                :key="session.id"
                class="session-card"
                :data-testid="session.current ? 'session-current' : 'session-other'"
                :data-session-id="session.id"
            >
                <svg class="device-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                        :d="ICONS[session.deviceType]"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                    />
                </svg>
                <div class="session-body">
                    <div class="session-title">
                        <strong>{{ deviceLabel(session) }}</strong>
                        <span class="visually-hidden">
                            {{ t(`account.sessions.deviceTypes.${session.deviceType}`) }}
                        </span>
                        <span v-if="session.current" class="badge badge-current">
                            {{ t('account.sessions.thisDevice') }}
                        </span>
                        <span
                            v-if="session.online"
                            class="badge badge-online"
                            data-testid="session-online"
                        >
                            {{ t('account.sessions.online') }}
                        </span>
                    </div>
                    <p class="session-meta">
                        <span>{{ t('account.sessions.ip', { ip: session.ip }) }}</span>
                        <span>{{ methodLabel(session) }}</span>
                    </p>
                    <p class="session-meta">
                        <span>
                            {{
                                t('account.sessions.signedIn', {
                                    date: formatDateTime(session.signedInAt),
                                })
                            }}
                        </span>
                        <span :title="t('account.sessions.lastSeenHint')">
                            {{ lastSeenLabel(session.lastSeenAt) }}
                        </span>
                    </p>
                    <p class="session-ua" :title="session.userAgent">{{ session.userAgent }}</p>
                </div>
                <button
                    v-if="!session.current"
                    class="secondary-button"
                    type="button"
                    data-testid="session-end"
                    :disabled="sessions.ending.value.has(session.id)"
                    @click="pending = { kind: 'one', session }"
                >
                    {{ t('account.sessions.end') }}
                </button>
            </li>
        </ul>

        <p
            v-if="
                sessions.loaded.value &&
                sessions.others.value.length === 0 &&
                !sessions.nextCursor.value
            "
            class="form-message"
            data-testid="sessions-empty"
        >
            {{ t('account.sessions.empty') }}
        </p>

        <div class="session-actions">
            <button
                v-if="sessions.nextCursor.value"
                class="secondary-button"
                type="button"
                data-testid="sessions-more"
                :disabled="sessions.loadingMore.value"
                @click="sessions.loadMore()"
            >
                {{ t('account.sessions.showMore') }}
            </button>
            <button
                v-if="sessions.others.value.length > 0 || sessions.nextCursor.value"
                class="secondary-button"
                type="button"
                data-testid="sessions-end-others"
                :disabled="sessions.endingOthers.value"
                @click="pending = { kind: 'others' }"
            >
                {{ t('account.sessions.endOthers') }}
            </button>
        </div>

        <p
            v-if="noticeText"
            class="form-message"
            :class="{ 'status-warning': noticeIsError }"
            role="status"
            data-testid="sessions-notice"
        >
            {{ noticeText }}
        </p>

        <ConfirmDialog
            v-if="pending"
            :title="
                pending.kind === 'one'
                    ? t('account.sessions.confirmEndTitle')
                    : t('account.sessions.confirmEndOthersTitle')
            "
            :text="confirmText"
            :confirm-label="t('account.sessions.confirm')"
            :cancel-label="t('account.sessions.cancel')"
            @confirm="confirm"
            @cancel="pending = null"
        />
    </section>
</template>

<style scoped>
.panel {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 20px;
}

.panel h2 {
    margin: 0 0 8px;
}

.hint,
.form-message {
    margin: 0 0 12px;
    color: var(--text-secondary);
}

.status-warning {
    color: var(--warning-color, #a16207);
}

.session-list {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: grid;
    gap: 10px;
}

.session-card {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;
    background: var(--bg-primary);
}

.device-icon {
    width: 28px;
    height: 28px;
    flex: none;
    color: var(--text-secondary);
}

.session-body {
    flex: 1;
    min-width: 0;
}

.session-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}

.badge {
    font-size: 12px;
    border-radius: 999px;
    padding: 2px 8px;
    border: 1px solid var(--border-color);
}

.badge-current {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: #fff;
}

.badge-online {
    color: var(--success-color, #15803d);
    border-color: currentColor;
}

.session-meta {
    margin: 4px 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    color: var(--text-secondary);
    font-size: 14px;
}

.session-ua {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.session-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.secondary-button {
    min-height: 36px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0 12px;
    cursor: pointer;
    background: var(--bg-primary);
    color: var(--text-primary);
}

.secondary-button:disabled {
    cursor: default;
    opacity: 0.6;
}

.visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
}
</style>
