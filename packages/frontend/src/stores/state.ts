import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { isPwaMode } from '@/utils/app-type'
import type { StorageConfig } from '@/utils/storage-url'

export type { StorageConfig }

export const useStateStore = defineStore('state', () => {
    const theme = localStorage.getItem('theme')
    const darkMode = ref(theme === 'dark')
    const colorTheme = ref(localStorage.getItem('colorTheme') || 'rose')
    const savedFontSize = Number(localStorage.getItem('fontSize'))
    const fontSize = ref(
        Number.isFinite(savedFontSize) ? Math.min(Math.max(savedFontSize, 14), 20) : 16,
    )
    const windowWidth = ref(window.innerWidth)
    const isMobile = ref(window.innerWidth <= 768)
    const isPWAMode = ref(false)

    const storageConfig = ref<StorageConfig>({
        cdnUrl: '',
        s3Prefix: '',
        s3StaticDataPrefix: '',
        s3DynamicDataPrefix: '',
    })

    const handleResize = () => {
        windowWidth.value = window.innerWidth
        isMobile.value = window.innerWidth <= 768
    }

    const setStorageConfig = (config: Partial<StorageConfig>) => {
        storageConfig.value = {
            ...storageConfig.value,
            ...config,
        }
    }

    // Функция для определения режима PWA
    const checkPWAMode = () => {
        isPWAMode.value = isPwaMode()
        return isPWAMode.value
    }

    // Инициализируем проверку PWA режима
    checkPWAMode()

    // Отслеживаем изменения display-mode
    const standaloneMediaQuery = window.matchMedia('(display-mode: standalone)')
    const minimalUIMediaQuery = window.matchMedia('(display-mode: minimal-ui)')

    standaloneMediaQuery.addEventListener('change', checkPWAMode)
    minimalUIMediaQuery.addEventListener('change', checkPWAMode)

    window.addEventListener('resize', handleResize)

    // Применение темы
    function applyTheme() {
        if (darkMode.value) {
            document.documentElement.classList.add('dark-theme')
            localStorage.setItem('theme', 'dark')
        } else {
            document.documentElement.classList.remove('dark-theme')
            localStorage.setItem('theme', 'light')
        }
        document.documentElement.setAttribute('data-theme', colorTheme.value)
        localStorage.setItem('colorTheme', colorTheme.value)
    }

    // Применение глобального размера шрифта
    function applyFontSize() {
        const clampedFontSize = Math.min(Math.max(fontSize.value, 14), 20)
        const scale = clampedFontSize / 16
        document.documentElement.style.setProperty('--app-font-size', `${clampedFontSize}px`)
        document.documentElement.style.fontSize = `${clampedFontSize}px`
        document.documentElement.style.setProperty('--app-font-scale', String(scale))

        // document.body is null while the <head> is still being parsed.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (document.body) {
            // Never scale the whole page; font size setting should only affect typography.
            document.body.style.zoom = ''
        }

        localStorage.setItem('fontSize', String(clampedFontSize))
    }

    // Вызываем сразу для инициализации темы
    applyTheme()
    applyFontSize()

    function setDarkMode(value: boolean) {
        darkMode.value = value
        applyTheme()
    }

    function setColorTheme(value: string) {
        colorTheme.value = value
        applyTheme()
    }

    function setFontSize(value: number) {
        fontSize.value = value
        applyFontSize()
    }

    // Отслеживаем изменения темы
    watch(darkMode, applyTheme)
    watch(colorTheme, applyTheme)
    watch(fontSize, applyFontSize)

    return {
        darkMode,
        setDarkMode,
        colorTheme,
        setColorTheme,
        fontSize,
        setFontSize,
        windowWidth,
        isMobile,
        isPWAMode,
        checkPWAMode,
        storageConfig,
        setStorageConfig,
    }
})
