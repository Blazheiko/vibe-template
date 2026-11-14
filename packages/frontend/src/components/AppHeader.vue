<script setup lang="ts">
import { useRouter, useRoute } from 'vue-router'
import MenuButton from '@/components/MenuButton.vue'
import { computed } from 'vue'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'

// Props
defineProps({
    title: {
        type: String,
        default: '',
    },
    showBack: {
        type: Boolean,
        default: false,
    },
})

const router = useRouter()
const route = useRoute()

const activeNav = computed(() => route.path)

// WebSocket connection status
const { statusWebSocket } = useWebSocketConnection()

// Computed properties for WebSocket status
const websocketStatusText = computed(() => {
    switch (statusWebSocket.value) {
        case 'OPEN':
            return 'Connected'
        case 'CONNECTING':
            return 'Connecting...'
        case 'CLOSED':
            return 'Disconnected'
        default:
            return 'Unknown'
    }
})

const websocketStatusClass = computed(() => {
    switch (statusWebSocket.value) {
        case 'OPEN':
            return 'status-connected'
        case 'CONNECTING':
            return 'status-connecting'
        case 'CLOSED':
            return 'status-disconnected'
        default:
            return 'status-unknown'
    }
})

// Вернуться назад
const goBack = () => {
    router.back()
}
</script>

<template>
    <header class="app-header">
        <div class="header-content">
            <div class="left-side">
                <button v-if="showBack" class="back-button" @click="goBack">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        width="24"
                        height="24"
                        fill="currentColor"
                    >
                        <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                    </svg>
                    <span>Back</span>
                </button>
            </div>

            <div class="right-side">
                <nav class="main-nav">
                    <button
                        class="nav-item"
                        :class="{ active: activeNav === '/support' }"
                        @click="router.push('/support')"
                        title="Support"
                    >
                        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
                            <path
                                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"
                                fill="currentColor"
                            />
                        </svg>
                        <span>Support</span>
                    </button>
                </nav>

                <!-- WebSocket Status Indicator -->
                <div
                    class="websocket-status"
                    :class="websocketStatusClass"
                    :title="`WebSocket Status: ${websocketStatusText}`"
                >
                    <div class="status-dot"></div>
                    <span class="status-text">{{ websocketStatusText }}</span>
                </div>

                <MenuButton />
            </div>
        </div>
    </header>
</template>

<style scoped>
.app-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background-color: var(--app-header-bg, #2146bfff);
    color: white;
    box-shadow: var(--box-shadow);
    width: 100%;
    padding: 0;
    height: var(--header-height);
    z-index: 300;
    position: relative;
}

.nav-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--danger-color);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
}

.dark-theme .app-header {
    background-color: var(--app-header-dark-bg, rgba(15, 23, 42, 0.85));
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--glass-border);
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
}

.header-content {
    width: 100%;
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.left-side,
.right-side {
    flex: 1;
    display: flex;
    align-items: center;
}

.left-side {
    justify-content: flex-start;
}

.right-side {
    justify-content: flex-end;
}

.main-nav {
    display: flex;
    gap: 2px;
    margin-right: 12px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 2px;
}

.nav-item {
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.8);
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: calc(11px * var(--app-font-scale, 1));
    font-weight: 500;
    line-height: 1.2;
    height: 20px;
    min-width: 52px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    transition: all 0.2s ease;
    white-space: nowrap;
}

.nav-item svg {
    flex-shrink: 0;
    opacity: 0.85;
}

.nav-item:hover {
    background-color: rgba(255, 255, 255, 0.15);
    color: white;
}

.nav-item.active {
    background: white;
    color: var(--primary-color);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.nav-item.active svg {
    opacity: 1;
}

.dark-theme .nav-item.active {
    background: rgba(255, 255, 255, 0.25);
    color: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.app-header h1 {
    margin: 0;
    font-weight: 600;
    font-size: calc(24px * var(--app-font-scale, 1));
}

.title-slot {
    flex: 1;
    text-align: center;
}

.back-button {
    padding: 8px 14px 8px 12px;
    background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.08)),
        rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.38);
    color: white;
    border-radius: 12px;
    cursor: pointer;
    transition:
        transform 0.18s ease,
        box-shadow 0.18s ease,
        border-color 0.18s ease,
        background-color 0.18s ease;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: calc(14px * var(--app-font-scale, 1));
    font-weight: 600;
    letter-spacing: 0.01em;
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.22),
        0 4px 12px rgba(11, 25, 51, 0.18);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
}

.back-button:hover {
    background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.33), rgba(255, 255, 255, 0.12)),
        rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.72);
    transform: translateY(-1px) scale(1.01);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.3),
        0 8px 18px rgba(11, 25, 51, 0.24);
}

.back-button:active {
    transform: translateY(0);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.2),
        0 4px 10px rgba(11, 25, 51, 0.2);
}

.back-button:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.92);
    outline-offset: 2px;
}

.back-button svg {
    width: 18px;
    height: 18px;
    opacity: 0.96;
    transition: transform 0.18s ease;
}

.back-button:hover svg {
    transform: translateX(-1px);
}

.dark-theme .back-button {
    background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.2), rgba(148, 163, 184, 0.06)),
        rgba(15, 23, 42, 0.16);
    border-color: rgba(226, 232, 240, 0.42);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.14),
        0 6px 14px rgba(2, 6, 23, 0.36);
}

.dark-theme .back-button:hover {
    border-color: rgba(248, 250, 252, 0.72);
    box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.2),
        0 8px 20px rgba(2, 6, 23, 0.42);
}

/* WebSocket Status Indicator */
.websocket-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 12px;
    font-size: calc(11px * var(--app-font-scale, 1));
    font-weight: 500;
    margin-right: 8px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    transition: all 0.2s ease;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    transition: all 0.2s ease;
}

.status-text {
    color: white;
    font-size: calc(10px * var(--app-font-scale, 1));
    line-height: 1;
}

/* Status Colors */
.status-connected .status-dot {
    background-color: #4ade80; /* green-400 */
    box-shadow: 0 0 6px rgba(74, 222, 128, 0.6);
}

.status-connecting .status-dot {
    background-color: #fbbf24; /* amber-400 */
    box-shadow: 0 0 6px rgba(251, 191, 36, 0.6);
    animation: pulse 2s infinite;
}

.status-disconnected .status-dot {
    background-color: #f87171; /* red-400 */
    box-shadow: 0 0 6px rgba(248, 113, 113, 0.6);
}

.status-unknown .status-dot {
    background-color: #9ca3af; /* gray-400 */
}

@keyframes pulse {
    0%,
    100% {
        opacity: 1;
    }
    50% {
        opacity: 0.5;
    }
}

@media (max-width: 768px) {
    .app-header {
        padding: 0;
    }

    .header-content {
        padding: 0 12px;
    }

    .right-side {
        gap: 8px;
        padding-right: 4px;
    }

    /* На мобильных основную навигацию не показываем */
    .main-nav {
        display: none;
    }

    /* WebSocket status на мобильных - показываем только точку */
    .websocket-status {
        padding: 4px;
        margin-right: 8px;
    }

    .websocket-status .status-text {
        display: none;
    }

    .websocket-status .status-dot {
        width: 10px;
        height: 10px;
    }

    .app-header h1 {
        font-size: calc(18px * var(--app-font-scale, 1));
    }

    .back-button {
        padding: 10px 12px;
        font-size: calc(14px * var(--app-font-scale, 1));
        min-height: 44px;
        min-width: 44px;
        justify-content: center;
        border-radius: 12px;
    }

    .back-button span {
        display: none;
    }
}
</style>
