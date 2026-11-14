import { fileURLToPath, URL } from 'node:url'

import { defaultClientConditions, defaultServerConditions, defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { landing } from './build/landing-plugin'
import { loadLandingUrls } from './build/load-urls'

// https://vite.dev/config/
export default defineConfig(({ command, mode, isSsrBuild }) => {
    // The address contract (build/urls.ts): LANDING_APP_URL / LANDING_SITE_URL from the shell,
    // else FRONTEND_URL / LANDING_URL from packages/backend/.env, else the dev servers. The
    // landing needs no .env of its own.
    const urls = loadLandingUrls()
    // The dev server reads `shared` from its src/ (the `shared-source` export condition), so a
    // change there needs no rebuild; `vite build` and Vitest stay on dist/ (frontend/vite.shared-source.ts).
    const sharedSource = command === 'serve' && mode !== 'test'
    return {
        // Not a SPA: an unknown path is a 404, as on nginx, and not index.html with 200.
        appType: 'mpa',
        plugins: [vue(), landing(urls)],
        resolve: {
            alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
            ...(sharedSource ? { conditions: ['shared-source', ...defaultClientConditions] } : {}),
        },
        ssr: sharedSource
            ? { resolve: { conditions: ['shared-source', ...defaultServerConditions] } }
            : {},
        build: {
            // The SSR bundle is only read by the prerender step and then removed.
            copyPublicDir: isSsrBuild !== true,
        },
        server: { port: 5175, strictPort: true },
        preview: { port: 4174, strictPort: true },
    }
})
