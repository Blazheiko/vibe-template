/**
 * What the service worker stores on install, next to the HTML shell. Every path must exist in
 * `public/` (`service-worker-fetch.spec.ts` checks it): a missing one is a 404 on each install.
 */
export const PRECACHE_FILES: readonly string[] = [
    '/',
    '/manifest.json',
    '/favicon.svg',
    '/icons/badge-72.png',
    '/icons/icon_192x192.png',
    '/icons/icon_512x512.png',
    '/icons/apple-touch-icon-120x120.png',
    '/icons/apple-touch-icon-152x152.png',
    '/icons/apple-touch-icon-167x167.png',
    '/icons/apple-touch-icon.png',
    '/icons/icon_maskable_192x192.png',
    '/icons/icon_maskable_512x512.png',
    '/splash/apple-splash-1170x2532.png',
    '/splash/apple-splash-1179x2556.png',
    '/splash/apple-splash-1290x2796.png',
    '/splash/splash-1080x2400.png',
    '/screenshots/editor-mobile.png',
    '/screenshots/templates-mobile.png',
]
