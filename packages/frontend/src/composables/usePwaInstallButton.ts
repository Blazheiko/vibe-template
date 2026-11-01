import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useStateStore } from '@/stores/state'
import type { BeforeInstallPromptEvent } from '@/utils/pwa-install'
import { promptPwaInstall, usePwaInstallState } from '@/utils/pwa-install'

/** The `<pwa-install>` custom element of @khmyznikov/pwa-install, as far as this code uses it. */
export type PwaInstallElement = HTMLElement & {
    externalPromptEvent?: BeforeInstallPromptEvent | null
    isInstallAvailable: boolean
    showDialog(): void
}

export interface InstallAvailabilityInput {
    isAppInstalled: boolean
    /** The browser handed us a `beforeinstallprompt` we can still use. */
    browserInstallAvailable: boolean
    /** This browser has `BeforeInstallPromptEvent` at all (Chromium). */
    supportsNativeInstallPrompt: boolean
    /** The element says it can install (the fallback for browsers without the event). */
    elementInstallAvailable: boolean
}

/**
 * Whether to offer "Install App". Where the browser has its own prompt, only its event counts and
 * the element's opinion is ignored; the element decides only where there is no such event (Safari).
 */
export function resolveInstallAvailable(input: InstallAvailabilityInput): boolean {
    if (input.isAppInstalled) return false
    if (input.browserInstallAvailable) return true
    if (input.supportsNativeInstallPrompt) return false
    return input.elementInstallAvailable
}

const FALLBACK_ACCENT = '#A8627A'

function getAccentColor(): string {
    if (typeof window === 'undefined') return FALLBACK_ACCENT
    return (
        getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() ||
        FALLBACK_ACCENT
    )
}

export interface PwaInstallButton {
    /** Bind to `<pwa-install ref="pwaInstall">`. */
    pwaInstall: Ref<PwaInstallElement | null>
    /** The element is left out of the page once the app is installed. */
    shouldMountPwaInstall: ComputedRef<boolean>
    isInstallAvailable: ComputedRef<boolean>
    /** The dialog of the element takes its colours from the theme in force. */
    pwaStyles: Ref<Record<string, string>>
    installApp: () => Promise<void>
}

/**
 * The state behind the "Install App" item of the menu: the browser's own prompt where there is one,
 * the `<pwa-install>` dialog where there is not.
 *
 * @param beforeInstall runs first, e.g. to close the menu the click came from
 */
export function usePwaInstallButton(beforeInstall: () => void): PwaInstallButton {
    const stateStore = useStateStore()
    const pwaInstall = ref<PwaInstallElement | null>(null)
    const elementInstallAvailable = ref(false)
    const pwaStyles = ref<Record<string, string>>({})
    const {
        isInstallAvailable: browserInstallAvailable,
        deferredPromptEvent,
        hasInstalledRelatedApp,
    } = usePwaInstallState()

    const supportsNativeInstallPrompt = computed(
        () => typeof window !== 'undefined' && 'BeforeInstallPromptEvent' in window,
    )
    const isAppInstalled = computed(() => stateStore.isPWAMode || hasInstalledRelatedApp.value)
    const isInstallAvailable = computed(() =>
        resolveInstallAvailable({
            isAppInstalled: isAppInstalled.value,
            browserInstallAvailable: browserInstallAvailable.value,
            supportsNativeInstallPrompt: supportsNativeInstallPrompt.value,
            elementInstallAvailable: elementInstallAvailable.value,
        }),
    )
    const shouldMountPwaInstall = computed(() => !isAppInstalled.value)

    function syncPwaStyles(): void {
        const accent = getAccentColor()
        pwaStyles.value = {
            '--tint-color': accent,
            '--background-color-button': accent,
        }
    }

    const handleInstallAvailable = (): void => {
        elementInstallAvailable.value = true
    }

    const handleInstallSuccess = (): void => {
        elementInstallAvailable.value = false
    }

    const syncElementInstallAvailability = (): void => {
        elementInstallAvailable.value = Boolean(pwaInstall.value?.isInstallAvailable)
    }

    async function installApp(): Promise<void> {
        beforeInstall()

        const nativeInstallOutcome = await promptPwaInstall()
        if (nativeInstallOutcome !== null) {
            elementInstallAvailable.value = false
            return
        }

        pwaInstall.value?.showDialog()
    }

    // The ref is already null by the time onUnmounted runs, so keep the element listened to
    let listenedTo: PwaInstallElement | null = null

    onMounted(async () => {
        syncPwaStyles()

        // The element renders after mount; listen to it once it is there
        await nextTick()
        if (pwaInstall.value) {
            listenedTo = pwaInstall.value
            listenedTo.externalPromptEvent = deferredPromptEvent.value
            listenedTo.addEventListener('pwa-install-available-event', handleInstallAvailable)
            listenedTo.addEventListener('pwa-install-success-event', handleInstallSuccess)
            syncElementInstallAvailability()
        }
    })

    onUnmounted(() => {
        listenedTo?.removeEventListener('pwa-install-available-event', handleInstallAvailable)
        listenedTo?.removeEventListener('pwa-install-success-event', handleInstallSuccess)
        listenedTo = null
    })

    watch([pwaInstall, deferredPromptEvent], () => {
        if (pwaInstall.value) {
            pwaInstall.value.externalPromptEvent = deferredPromptEvent.value
            syncElementInstallAvailability()
        }
    })

    watch(isAppInstalled, (isInstalled) => {
        if (isInstalled) elementInstallAvailable.value = false
    })

    watch([() => stateStore.colorTheme, () => stateStore.darkMode], syncPwaStyles)

    return { pwaInstall, shouldMountPwaInstall, isInstallAvailable, pwaStyles, installApp }
}
