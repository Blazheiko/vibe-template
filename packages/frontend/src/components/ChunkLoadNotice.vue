<script setup lang="ts">
// feat-278 (T5): what the user sees when a page chunk cannot be loaded and the automatic
// recovery does not reload by itself (offline, a reload that did not help, no sessionStorage).
import { useI18n } from 'vue-i18n'
import { chunkLoadNotice } from '@/utils/preload-recovery'

const { t } = useI18n()

function reload(): void {
    const notice = chunkLoadNotice.value
    if (notice !== null) window.location.assign(notice.target)
}
</script>

<template>
    <div v-if="chunkLoadNotice" class="chunk-load-notice" role="alert">
        <p class="message">
            {{
                chunkLoadNotice.kind === 'offline'
                    ? t('app.chunkLoad.offline')
                    : t('app.chunkLoad.failed')
            }}
        </p>
        <button
            v-if="chunkLoadNotice.kind === 'failed'"
            type="button"
            class="reload"
            @click="reload"
        >
            {{ t('app.chunkLoad.reload') }}
        </button>
    </div>
</template>

<style scoped>
.chunk-load-notice {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    z-index: 10000;
    width: min(420px, calc(100% - 32px));
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--glass-bg);
    color: var(--text-color);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
}

.message {
    flex: 1;
    margin: 0;
    font-size: calc(14px * var(--app-font-scale, 1));
}

.reload {
    padding: 6px 14px;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--primary-color);
    color: white;
    font-weight: 500;
    cursor: pointer;
}

.reload:hover {
    background: var(--accent-hover);
}
</style>
