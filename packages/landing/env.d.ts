/// <reference types="vite/client" />

// The landing reads no VITE_* variable: the addresses reach the pages as render arguments
// (build/urls.ts), so an undeclared one is a type error.
interface ViteTypeOptions {
    strictImportMetaEnv: unknown
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ImportMetaEnv {}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
