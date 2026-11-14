/// <reference types="vite/client" />
import 'vue-router'

declare module '*.vue' {
    import type { DefineComponent } from 'vue'
    const component: DefineComponent<object, object, unknown>
    export default component
}

declare module 'vue-router' {
    interface RouteMeta {
        requiresAuth?: boolean
        title?: string
        hideHeader?: boolean
        authModal?: 'login' | 'register'
        requiresAdmin?: boolean
        showBack?: boolean
    }
}

declare global {
    // An undeclared VITE_* variable is a type error (code-issues item 61).
    interface ViteTypeOptions {
        strictImportMetaEnv: unknown
    }

    // Every VITE_* the app reads (code-issues item 61); values are build-time strings.
    interface ImportMetaEnv {
        /** API origin; empty — same origin (Vite proxy in dev). */
        readonly VITE_BASE_URL?: string
        /** Set by vite.config.ts from the backend API_PATH_PREFIX (default `api`), not by hand. */
        readonly VITE_API_PATH_PREFIX?: string
        /** `'true'` enables sign-in and registration by phone. */
        readonly VITE_AUTH_PHONE_ENABLED?: string
        readonly VITE_SENTRY_ENABLED?: string
        readonly VITE_SENTRY_DSN?: string
        readonly VITE_SENTRY_ENVIRONMENT?: string
        readonly VITE_SENTRY_RELEASE?: string
        readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string
        readonly VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE?: string
        readonly VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE?: string
    }

    interface ImportMeta {
        readonly env: ImportMetaEnv
    }

    const BUILD_TIMESTAMP: string

    // Speech Recognition API types
    interface SpeechRecognition extends EventTarget {
        continuous: boolean
        interimResults: boolean
        lang: string
        maxAlternatives: number
        start(): void
        stop(): void
        abort(): void
        onstart: ((this: SpeechRecognition, ev: Event) => void) | null
        onend: ((this: SpeechRecognition, ev: Event) => void) | null
        onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
        onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
    }

    interface SpeechRecognitionErrorEvent extends Event {
        error: string
        message: string
    }

    interface SpeechRecognitionEvent extends Event {
        resultIndex: number
        results: SpeechRecognitionResultList
    }

    interface SpeechRecognitionResultList {
        length: number
        item(index: number): SpeechRecognitionResult
        [index: number]: SpeechRecognitionResult
    }

    interface SpeechRecognitionResult {
        length: number
        item(index: number): SpeechRecognitionAlternative
        [index: number]: SpeechRecognitionAlternative
        isFinal: boolean
    }

    interface SpeechRecognitionAlternative {
        transcript: string
        confidence: number
    }

    const SpeechRecognition: {
        prototype: SpeechRecognition
        new (): SpeechRecognition
    }

    const webkitSpeechRecognition: {
        prototype: SpeechRecognition
        new (): SpeechRecognition
    }

    interface Window {
        SpeechRecognition: typeof SpeechRecognition
        webkitSpeechRecognition: typeof webkitSpeechRecognition
    }
}

export {}
