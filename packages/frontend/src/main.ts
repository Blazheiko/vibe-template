// First, before the router and Sentry are loaded: takes ?token= of a mailed link out of
// the address (feat-205).
import '@/utils/strip-url-token'
import './assets/main.css'
import './styles.css'
import './shared-components.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { useEventBus } from '@/utils/event-bus'
import { startServiceWorker } from '@/utils/sw-manager'
import { i18n } from '@/plugins/i18n'
import { sentryService as sentry } from '@/utils/sentry-service'
import { initializePwaInstallTracking } from '@/utils/pwa-install'
import { initLocaleStandalone } from '@/composables/useLocale'
import { isNavigationFailure } from 'vue-router'

initializePwaInstallTracking()

void bootstrap()

async function bootstrap() {
    await initLocaleStandalone()

    const app = createApp(App)

    app.use(createPinia())
    app.use(router)
    app.use(i18n)
    router.onError((error, to) => {
        if (isNavigationFailure(error)) {
            return
        }

        // `to.path` and the route name only: `fullPath` carries the query (`?token=…`).
        sentry.captureException(error, {
            extra: {
                targetRoute: to.path || '',
                targetRouteName: to.name === undefined ? '' : String(to.name),
            },
        })
    })

    sentry.init(app, router)

    app.mount('#app')
}

startServiceWorker({
    appBuildTimestamp: BUILD_TIMESTAMP,
    reportError: (error, extra) => {
        sentry.captureException(error, { tags: { source: 'service-worker' }, extra })
    },
    announceUpdate: () => {
        useEventBus().emit('update_available')
    },
})
