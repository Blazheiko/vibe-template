<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { OAuthProvider } from 'shared/responses'
import { useOAuthProviders } from '@/composables/useOAuthProviders'
import { apiPath } from '@/utils/api-path'
import { rememberPostSignInTarget } from '@/utils/post-sign-in-target'

// Buttons only for providers configured on the backend; nothing at all when none are.
const props = defineProps<{
    // When set, a click is handed to the parent (e.g. to require the terms checkbox)
    // instead of navigating right away.
    interceptClick?: boolean
}>()
const emit = defineEmits<{ select: [url: string] }>()

const { t } = useI18n()
const { providers } = useOAuthProviders()

const LABELS: Record<OAuthProvider, string> = {
    google: 'Google',
    facebook: 'Facebook',
    github: 'GitHub',
    gitlab: 'GitLab',
}

const buttons = computed(() =>
    providers.value.map((provider) => ({
        provider,
        label: LABELS[provider],
        url: apiPath(`auth/oauth/${provider}/redirect`),
    })),
)

function onClick(event: MouseEvent, url: string): void {
    // The sign-in leaves the application and comes back to "/": the page the router guard put
    // into ?redirect= is kept in the tab for the trip (feat-154). No redirect in the address
    // forgets what an earlier, unfinished sign-in kept.
    rememberPostSignInTarget(new URLSearchParams(window.location.search).get('redirect'))
    if (!props.interceptClick) return
    event.preventDefault()
    emit('select', url)
}
</script>

<template>
    <template v-if="buttons.length > 0">
        <div class="social-divider">
            <span>{{ t('auth.orContinueWith') }}</span>
        </div>
        <div class="social-buttons">
            <a
                v-for="button in buttons"
                :key="button.provider"
                :href="button.url"
                :class="['social-btn', `social-btn-${button.provider}`]"
                :data-provider="button.provider"
                @click="onClick($event, button.url)"
            >
                <svg v-if="button.provider === 'google'" viewBox="0 0 24 24" width="18" height="18">
                    <path
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                        fill="#4285F4"
                    />
                    <path
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        fill="#34A853"
                    />
                    <path
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        fill="#FBBC05"
                    />
                    <path
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        fill="#EA4335"
                    />
                </svg>
                <svg
                    v-else-if="button.provider === 'facebook'"
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="#1877F2"
                >
                    <path
                        d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
                    />
                </svg>
                <svg
                    v-else-if="button.provider === 'github'"
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="currentColor"
                >
                    <path
                        d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"
                    />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="#FC6D26">
                    <path
                        d="m23.6 9.6-.03-.09-3.3-8.6a.86.86 0 0 0-1.63.06l-2.22 6.8H7.58L5.36.97a.86.86 0 0 0-1.63-.06L.43 9.5l-.03.09a6.1 6.1 0 0 0 2.02 7.05l.01.01.03.02 5.03 3.77 2.49 1.88 1.51 1.14a1.02 1.02 0 0 0 1.23 0l1.51-1.14 2.49-1.88 5.06-3.79.01-.01a6.1 6.1 0 0 0 2.02-7.04z"
                    />
                </svg>
                <span>{{ button.label }}</span>
            </a>
        </div>
    </template>
</template>

<style scoped>
.social-divider {
    display: flex;
    align-items: center;
    margin: 14px 0;
    gap: 12px;
}

.social-divider::before,
.social-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background-color: var(--border-color, #e0e0e0);
}

.dark-theme .social-divider::before,
.dark-theme .social-divider::after {
    background-color: #444;
}

.social-divider span {
    font-size: calc(13px * var(--app-font-scale, 1));
    color: var(--text-secondary, #6c757d);
    white-space: nowrap;
}

.dark-theme .social-divider span {
    color: #adb5bd;
}

.social-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
}

.social-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 8px;
    background-color: #fff;
    color: var(--text-color, #333);
    font-size: calc(13px * var(--app-font-scale, 1));
    font-weight: 500;
    text-decoration: none;
    transition: all 0.2s ease;
    cursor: pointer;
}

.dark-theme .social-btn {
    background-color: #2a2a2a;
    border-color: #444;
    color: #e0e0e0;
}

.social-btn:hover {
    background-color: #f8f9fa;
    border-color: #ccc;
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.dark-theme .social-btn:hover {
    background-color: #333;
    border-color: #555;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.social-btn svg {
    flex-shrink: 0;
}
@media (max-width: 640px) {
    .social-buttons {
        grid-template-columns: 1fr;
    }
}
</style>
