<script setup lang="ts">
import '@khmyznikov/pwa-install'
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useStateStore } from '@/stores/state'
import PwaInstallButton from '@/components/PwaInstallButton.vue'
import { usePwaInstallButton } from '@/composables/usePwaInstallButton'
import { useSessionLifecycle } from '@/composables/useSessionLifecycle'

const router = useRouter()
//const route = useRoute()
const stateStore = useStateStore()
const { logout: logoutSession } = useSessionLifecycle()

// Состояние меню
const isMenuOpen = ref(false)

// Loading state for logout
const isLoggingOut = ref(false)

// Accordion state — открытая группа ('navigation' | 'account' | 'legal' | null)
const openGroup = ref<'navigation' | 'account' | 'legal' | null>('navigation')

const toggleGroup = (group: 'navigation' | 'account' | 'legal') => {
    openGroup.value = openGroup.value === group ? null : group
}

// PWA установка
const { pwaInstall, shouldMountPwaInstall, isInstallAvailable, pwaStyles, installApp } =
    usePwaInstallButton(() => {
        closeMenu()
    })

// Управление меню
const toggleMenu = () => {
    isMenuOpen.value = !isMenuOpen.value
}

const closeMenu = () => {
    isMenuOpen.value = false
}

// Обработчик клика вне меню
const handleClickOutside = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    if (isMenuOpen.value && !target.closest('.menu-container')) {
        closeMenu()
    }
}

// Добавляем обработчики событий
onMounted(() => {
    window.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
    window.removeEventListener('click', handleClickOutside)
})

// Переход в аккаунт
const goToAccount = () => {
    closeMenu()
    void router.push('/account')
}

const goTo = (path: string) => {
    closeMenu()
    void router.push(path)
}

// Переключение темы
const toggleTheme = () => {
    stateStore.setDarkMode(!stateStore.darkMode)
    closeMenu()
}

// Выход из аккаунта
const logout = async () => {
    isLoggingOut.value = true

    try {
        await logoutSession()
    } finally {
        isLoggingOut.value = false
        closeMenu()
    }
}
</script>

<template>
    <div class="menu-container">
        <pwa-install
            v-if="shouldMountPwaInstall"
            ref="pwaInstall"
            manifest-url="/manifest.json"
            name="Vibe Template"
            description="Educational Vue 3 and TypeScript template with frontend, backend, shared packages, tests, and build tooling."
            icon="/icons/icon_192x192.png"
            disable-android-fallback
            :styles="pwaStyles"
        ></pwa-install>

        <button type="button" class="menu-button" @click.stop="toggleMenu">
            <svg
                class="menu-icon"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="white"
            >
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
            </svg>
        </button>

        <div class="dropdown-menu" :class="{ show: isMenuOpen }">
            <!-- Install App — всегда вверху если доступен -->
            <PwaInstallButton v-if="isInstallAvailable" @install="installApp" />

            <!-- Divider после Install App -->
            <div v-if="isInstallAvailable" class="menu-divider"></div>

            <!-- Группа: Navigation -->
            <button type="button" class="group-header" @click.stop="toggleGroup('navigation')">
                <div class="group-header-left">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="currentColor"
                    >
                        <path
                            d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"
                        />
                    </svg>
                    <span>Navigation</span>
                </div>
                <svg
                    class="chevron"
                    :class="{ open: openGroup === 'navigation' }"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="currentColor"
                >
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
                </svg>
            </button>

            <div class="group-items" :class="{ expanded: openGroup === 'navigation' }">
                <div class="group-items-inner">
                    <button type="button" class="menu-item" @click="goTo('/support')">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M12 2a10 10 0 1 0 10 10A10.01 10.01 0 0 0 12 2Zm1 17h-2v-2h2Zm2.07-7.75-.9.92A3.49 3.49 0 0 0 13 15h-2v-.5a4 4 0 0 1 1.17-2.83l1.24-1.26A1.96 1.96 0 0 0 14 9a2 2 0 0 0-4 0H8a4 4 0 0 1 8 0 3.2 3.2 0 0 1-.93 2.25Z"
                            />
                        </svg>
                        Support
                    </button>
                    <button type="button" class="menu-item" @click="goTo('/account')">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z"
                            />
                        </svg>
                        Account
                    </button>
                    <button type="button" class="menu-item" @click="goTo('/about')">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M11 17h2v-6h-2v6Zm1-14a9 9 0 1 0 9 9 9.01 9.01 0 0 0-9-9Zm0 16a7 7 0 1 1 7-7 7.01 7.01 0 0 1-7 7Zm-1-10h2V7h-2v2Z"
                            />
                        </svg>
                        About
                    </button>
                </div>
            </div>

            <div class="menu-divider"></div>

            <!-- Группа: Account -->
            <button type="button" class="group-header" @click.stop="toggleGroup('account')">
                <div class="group-header-left">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="currentColor"
                    >
                        <path
                            d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
                        />
                    </svg>
                    <span>Account</span>
                </div>
                <svg
                    class="chevron"
                    :class="{ open: openGroup === 'account' }"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="currentColor"
                >
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
                </svg>
            </button>

            <div class="group-items" :class="{ expanded: openGroup === 'account' }">
                <div class="group-items-inner">
                    <button type="button" class="menu-item" @click="goToAccount">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
                            />
                        </svg>
                        My Account
                    </button>
                    <button type="button" class="menu-item" @click="toggleTheme">
                        <svg
                            v-if="stateStore.darkMode"
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"
                            />
                        </svg>
                        <svg
                            v-else
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"
                            />
                        </svg>
                        {{ stateStore.darkMode ? 'Light Theme' : 'Dark Theme' }}
                    </button>
                </div>
            </div>

            <div class="menu-divider"></div>

            <!-- Группа: Legal & Support -->
            <button type="button" class="group-header" @click.stop="toggleGroup('legal')">
                <div class="group-header-left">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="currentColor"
                    >
                        <path
                            d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 4l6 2.67V11c0 3.93-2.63 7.63-6 8.93-3.37-1.3-6-5-6-8.93V7.67L12 5zm-1 4v2H9v2h2v2h2v-2h2v-2h-2V9h-2z"
                        />
                    </svg>
                    <span>Legal &amp; Support</span>
                </div>
                <svg
                    class="chevron"
                    :class="{ open: openGroup === 'legal' }"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="currentColor"
                >
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" />
                </svg>
            </button>

            <div class="group-items" :class="{ expanded: openGroup === 'legal' }">
                <div class="group-items-inner">
                    <button type="button" class="menu-item" @click="goTo('/support')">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z"
                            />
                        </svg>
                        Support
                    </button>
                    <button type="button" class="menu-item" @click="goTo('/ai-policy')">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73A2 2 0 0 1 10 4a2 2 0 0 1 2-2zm-2 9a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"
                            />
                        </svg>
                        AI Policy
                    </button>
                    <button type="button" class="menu-item" @click="goTo('/privacy-policy')">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 4l6 2.67V11c0 3.93-2.63 7.63-6 8.93-3.37-1.3-6-5-6-8.93V7.67L12 5zm-1 4v2H9v2h2v2h2v-2h2v-2h-2V9h-2z"
                            />
                        </svg>
                        Privacy Policy
                    </button>
                    <button type="button" class="menu-item" @click="goTo('/terms')">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"
                            />
                        </svg>
                        Terms &amp; Conditions
                    </button>
                    <button type="button" class="menu-item" @click="goTo('/cookies')">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="20"
                            height="20"
                            fill="currentColor"
                        >
                            <path
                                d="M21.95 10.99c-1.19.03-2.26-.79-2.38-1.97-.09-.88.37-1.67 1.08-2.1-.63-1.07-1.48-1.99-2.49-2.72-.56.81-1.61 1.24-2.67.91-1.14-.36-1.81-1.51-1.6-2.67-1.09-.16-2.2-.13-3.27.09.16 1.16-.51 2.31-1.65 2.67-1.06.33-2.11-.1-2.67-.91C5.3 5.52 4.45 6.44 3.82 7.51c.71.43 1.17 1.22 1.08 2.1-.12 1.18-1.19 2-2.38 1.97-.06.45-.09.9-.09 1.36 0 .48.03.94.09 1.39 1.19-.03 2.26.79 2.38 1.97.09.88-.37 1.67-1.08 2.1.63 1.07 1.48 1.99 2.49 2.72.56-.81 1.61-1.24 2.67-.91 1.14.36 1.81 1.51 1.6 2.67 1.08.16 2.2.13 3.27-.09-.16-1.16.51-2.31 1.65-2.67 1.06-.33 2.11.1 2.67.91 1.01-.73 1.86-1.65 2.49-2.72-.71-.43-1.17-1.22-1.08-2.1.12-1.18 1.19-2 2.38-1.97.06-.45.09-.91.09-1.39 0-.46-.03-.91-.09-1.36zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"
                            />
                        </svg>
                        Cookies Policy
                    </button>
                </div>
            </div>

            <div class="menu-divider"></div>

            <!-- Logout — всегда внизу -->
            <button
                type="button"
                class="menu-item logout-item"
                @click.prevent="logout"
                :disabled="isLoggingOut"
            >
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    fill="currentColor"
                >
                    <path
                        d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"
                    />
                </svg>
                <span v-if="isLoggingOut">Logging out...</span>
                <span v-else>Logout</span>
            </button>
        </div>
    </div>
</template>

<style scoped>
.menu-container {
    position: relative;
    z-index: 2;
}

.menu-button {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: white;
    padding: 3px 6px;
    height: 22px;
    width: 22px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: calc(11px * var(--app-font-scale, 1));
    font-weight: 500;
}

.menu-button:hover {
    background-color: rgba(255, 255, 255, 0.2);
    transform: translateY(-1px);
}

.menu-button:active {
    background-color: rgba(255, 255, 255, 0.25);
    transform: translateY(0);
}

/* Стили для выпадающего меню */
.dropdown-menu {
    position: absolute;
    top: calc(100% + 12px);
    right: 0;
    width: 220px;
    max-height: 80vh;
    overflow-y: auto;
    background-color: var(--bg-secondary);
    border: none;
    border-radius: 12px;
    box-shadow: var(--shadow-md);
    z-index: 1200;
    opacity: 0;
    transform: translateY(-10px);
    visibility: hidden;
    transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    padding: 6px 0;
}

.dropdown-menu.show {
    opacity: 1;
    transform: translateY(0);
    visibility: visible;
}

/* Разделитель */
.menu-divider {
    height: 1px;
    background-color: var(--border-color);
    margin: 4px 12px;
    opacity: 0.5;
}

/* Заголовок группы */
.group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 9px 15px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-primary);
    font-size: calc(12px * var(--app-font-scale, 1));
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    transition: color 0.15s ease;
}

.group-header:hover {
    color: var(--text-primary);
    opacity: 0.85;
}

.group-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
}

/* Шеврон */
.chevron {
    transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    flex-shrink: 0;
    opacity: 0.6;
}

.chevron.open {
    transform: rotate(180deg);
}

/* Контейнер элементов группы с анимацией высоты */
.group-items {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.28s cubic-bezier(0.4, 0, 0.2, 1);
    overflow: hidden;
}

.group-items.expanded {
    grid-template-rows: 1fr;
}

.group-items-inner {
    min-height: 0;
    overflow: hidden;
    margin-left: 10px;
    padding-left: 10px;
    margin-bottom: 4px;
}

/* Элемент меню */
.menu-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: calc(100% - 12px);
    text-align: left;
    padding: 7px 10px;
    background: none;
    border: none;
    cursor: pointer;
    transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
    color: var(--text-primary);
    border-radius: 6px;
    margin: 1px 6px;
    font-weight: 400;
    font-size: calc(13px * var(--app-font-scale, 1));
    position: relative;
    overflow: hidden;
    transform: translateY(0) scale(1);
}

.menu-item.install-app {
    color: var(--accent-color);
    font-weight: 600;
    font-size: calc(14px * var(--app-font-scale, 1));
}

.menu-item.logout-item {
    color: var(--danger-color);
    font-size: calc(14px * var(--app-font-scale, 1));
    font-weight: 500;
}

.menu-item:hover {
    background-color: var(--accent-light);
    transform: translateY(-1px) scale(1.02);
    box-shadow: var(--shadow-sm);
}

.menu-item:active {
    transform: translateY(1px) scale(0.98);
    transition: all 0.1s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.menu-item::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 0;
    height: 0;
    background: rgba(0, 0, 0, 0.1);
    border-radius: 50%;
    transform: translate(-50%, -50%);
    transition:
        width 0.3s ease,
        height 0.3s ease;
}

.menu-item:active::before {
    width: 200px;
    height: 200px;
}

.menu-item:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none;
}

.menu-item:disabled:hover {
    background-color: transparent;
    transform: none;
}

.menu-item:disabled::before {
    display: none;
}

@media (max-width: 768px) {
    .menu-container {
        margin-left: 4px;
    }

    .menu-button {
        padding: 6px;
        width: 32px;
        height: 32px;
        border-radius: 6px;
    }

    .menu-icon {
        width: 18px;
        height: 18px;
    }
}
</style>
