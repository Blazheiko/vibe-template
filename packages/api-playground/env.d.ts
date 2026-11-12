/// <reference types="vite/client" />

// An undeclared VITE_* variable is a type error (code-issues item 62).
interface ViteTypeOptions {
    strictImportMetaEnv: unknown
}

interface ImportMetaEnv {
    /** Backend origin; empty — same origin through the dev proxy. */
    readonly VITE_API_BASE_URL?: string
    /** Set by vite.config.ts from the backend API_PATH_PREFIX (default `api`), not by hand. */
    readonly VITE_API_PATH_PREFIX?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
