import { defineConfig, type DefaultTheme } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const repoUrl = 'https://github.com/Blazheiko/vibe-template'
const author = 'Олександр Блажейко'
const authorEmail = 'blazheiko@gmail.com'

const ukSide = {
    shared: 'Пакет shared',
    frontend: 'Фронтенд',
    playground: 'API Playground',
    packages: 'Пакети',
    firstDay: 'Перший день',
    g1: '1. Вступ',
    g2: '2. Швидкий старт',
    g3: '3. Як влаштований бекенд',
    g4: '4. Від запиту до контролера',
    g5: '5. Від контролера до відповіді',
    g6: '6. Перший маршрут',
    g7: '7. Як додати фічу',
    g8: '8. Свій проєкт на шаблоні',
    guide: 'Гайд',
    projectStructure: 'Структура проєкту',
    workflow: 'Процес роботи',
    csrf: 'CSRF простими словами',
    backend: 'Бекенд',
    howItWorks: 'Як влаштований (для новачків)',
    overview: 'Огляд',
    architecture: 'Архітектура',
    lifecycle: 'Життєвий цикл запиту',
    configuration: 'Конфігурація',
    controllers: 'Контролери',
    services: 'Сервіси',
    repositories: 'Репозиторії',
    transformers: 'Трансформери',
    validation: 'Валідація',
    responseValidation: 'Перевірка відповідей',
    routing: 'Маршрутизація',
    webRoutes: 'Веб-маршрути і публічний API',
    database: 'База даних',
    auth: 'Автентифікація',
    oauth: 'Вхід через соцмережі',
    security: 'Безпека',
    testing: 'Тестування',
    caching: 'Кешування та ETag',
    deployment: 'Деплой',
    integrations: 'Інтеграції',
    storage: 'Сховище файлів (S3)',
    mail: 'Пошта',
    webPush: 'Web Push сповіщення',
    ai: 'AI-інтеграції',
    tutorials: 'Туторіали',
    make: 'Команди make',
    scripts: 'Скрипти',
    glossary: 'Глосарій',
    roles: 'Ролі та можливості',
    author: 'Про автора',
}

type Side = typeof ukSide

const ukNav = {
    start: 'Почати навчання',
    backend: 'Бекенд',
    packages: 'Пакети',
    reference: 'Довідник',
}
type Nav = typeof ukNav

/** Nav + sidebar for one locale. `p` is the URL prefix ('' for uk, '/en' for en). */
function localeTheme(t: { p: string; nav: Nav; side: Side }): {
    nav: DefaultTheme.NavItem[]
    sidebar: DefaultTheme.Sidebar
} {
    const { p, nav, side } = t
    const packagesItems = [
        { text: side.shared, link: `${p}/shared/` },
        { text: side.frontend, link: `${p}/frontend/` },
        { text: side.playground, link: `${p}/playground/` },
    ]
    return {
        nav: [
            { text: nav.start, link: `${p}/guide/introduction` },
            { text: nav.backend, link: `${p}/backend/` },
            {
                text: nav.packages,
                items: [
                    { text: 'shared', link: `${p}/shared/` },
                    { text: side.frontend, link: `${p}/frontend/` },
                    { text: side.playground, link: `${p}/playground/` },
                ],
            },
            { text: nav.reference, link: `${p}/reference/scripts` },
        ],
        sidebar: {
            [`${p}/guide/`]: [
                {
                    text: side.firstDay,
                    items: [
                        { text: side.g1, link: `${p}/guide/introduction` },
                        { text: side.g2, link: `${p}/guide/getting-started` },
                        { text: side.g3, link: `${p}/guide/how-backend-works` },
                        { text: side.g4, link: `${p}/guide/http-request` },
                        { text: side.g5, link: `${p}/guide/http-response` },
                        { text: side.g6, link: `${p}/guide/first-endpoint` },
                        { text: side.g7, link: `${p}/backend/adding-a-feature` },
                        { text: side.g8, link: `${p}/guide/your-project` },
                    ],
                },
                {
                    text: side.guide,
                    items: [
                        { text: side.projectStructure, link: `${p}/guide/project-structure` },
                        { text: side.workflow, link: `${p}/guide/workflow` },
                        { text: side.csrf, link: `${p}/guide/csrf` },
                    ],
                },
            ],
            [`${p}/backend/`]: [
                {
                    text: side.backend,
                    items: [
                        { text: side.howItWorks, link: `${p}/guide/how-backend-works` },
                        { text: side.overview, link: `${p}/backend/` },
                        { text: side.architecture, link: `${p}/backend/architecture` },
                        { text: side.lifecycle, link: `${p}/backend/request-lifecycle` },
                        { text: side.configuration, link: `${p}/backend/configuration` },
                        { text: side.controllers, link: `${p}/backend/controllers` },
                        { text: side.services, link: `${p}/backend/services` },
                        { text: side.repositories, link: `${p}/backend/repositories` },
                        { text: side.transformers, link: `${p}/backend/transformers` },
                        { text: side.validation, link: `${p}/backend/validation` },
                        { text: side.responseValidation, link: `${p}/backend/response-validation` },
                        { text: side.routing, link: `${p}/backend/routing` },
                        { text: 'Middleware', link: `${p}/backend/middlewares` },
                        { text: side.webRoutes, link: `${p}/backend/web-and-api-routes` },
                        { text: side.database, link: `${p}/backend/database` },
                        { text: side.auth, link: `${p}/backend/auth` },
                        { text: side.oauth, link: `${p}/backend/oauth` },
                        { text: side.security, link: `${p}/backend/security` },
                        { text: 'WebSocket', link: `${p}/backend/websocket` },
                        { text: side.testing, link: `${p}/backend/testing` },
                        { text: side.caching, link: `${p}/backend/caching-etag` },
                        { text: 'Observability', link: `${p}/backend/observability` },
                        { text: side.deployment, link: `${p}/backend/deployment` },
                    ],
                },
                {
                    text: side.integrations,
                    items: [
                        { text: side.storage, link: `${p}/backend/storage` },
                        { text: side.mail, link: `${p}/backend/mail` },
                        { text: side.webPush, link: `${p}/backend/web-push-notification` },
                        { text: side.ai, link: `${p}/backend/ai` },
                    ],
                },
                {
                    text: side.tutorials,
                    items: [{ text: side.g7, link: `${p}/backend/adding-a-feature` }],
                },
            ],
            [`${p}/shared/`]: [{ text: side.packages, items: packagesItems }],
            [`${p}/frontend/`]: [{ text: side.packages, items: packagesItems }],
            [`${p}/playground/`]: [{ text: side.packages, items: packagesItems }],
            [`${p}/reference/`]: [
                {
                    text: nav.reference,
                    items: [
                        { text: side.make, link: `${p}/reference/make` },
                        { text: side.scripts, link: `${p}/reference/scripts` },
                        { text: 'Toolchain', link: `${p}/reference/toolchain` },
                        { text: side.glossary, link: `${p}/reference/glossary` },
                        { text: side.roles, link: `${p}/reference/roles-capabilities` },
                        { text: side.author, link: `${p}/reference/author` },
                    ],
                },
            ],
        },
    }
}

const enSide: Side = {
    shared: 'The shared package',
    frontend: 'Frontend',
    playground: 'API Playground',
    packages: 'Packages',
    firstDay: 'Day one',
    g1: '1. Introduction',
    g2: '2. Quick start',
    g3: '3. How the backend works',
    g4: '4. From request to controller',
    g5: '5. From controller to response',
    g6: '6. Your first route',
    g7: '7. How to add a feature',
    g8: '8. Your project on the template',
    guide: 'Guide',
    projectStructure: 'Project structure',
    workflow: 'Workflow',
    csrf: 'CSRF in plain words',
    backend: 'Backend',
    howItWorks: 'How it works (for beginners)',
    overview: 'Overview',
    architecture: 'Architecture',
    lifecycle: 'Request lifecycle',
    configuration: 'Configuration',
    controllers: 'Controllers',
    services: 'Services',
    repositories: 'Repositories',
    transformers: 'Transformers',
    validation: 'Validation',
    responseValidation: 'Response validation',
    routing: 'Routing',
    webRoutes: 'Web routes and public API',
    database: 'Database',
    auth: 'Authentication',
    oauth: 'Social login',
    security: 'Security',
    testing: 'Testing',
    caching: 'Caching and ETag',
    deployment: 'Deployment',
    integrations: 'Integrations',
    storage: 'File storage (S3)',
    mail: 'Mail',
    webPush: 'Web Push notifications',
    ai: 'AI integrations',
    tutorials: 'Tutorials',
    make: 'make commands',
    scripts: 'Scripts',
    glossary: 'Glossary',
    roles: 'Roles and capabilities',
    author: 'About the author',
}

const enNav: Nav = {
    start: 'Get started',
    backend: 'Backend',
    packages: 'Packages',
    reference: 'Reference',
}

const uk = localeTheme({ p: '', nav: ukNav, side: ukSide })
const en = localeTheme({ p: '/en', nav: enNav, side: enSide })

const siteUrl = 'https://blazheiko.github.io/vibe-template/'
const jsonLd = (description: string): string =>
    JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'vibe-template',
        url: siteUrl,
        description,
        author: {
            '@type': 'Person',
            name: author,
            email: `mailto:${authorEmail}`,
            url: 'https://github.com/Blazheiko',
        },
    })

const ukDescription =
    'Документація full-stack TypeScript шаблону: Vue 3, uWebSockets.js, shared контракти'
const enDescription =
    'Documentation of the full-stack TypeScript template: Vue 3, uWebSockets.js, shared contracts'

const config = withMermaid(
    defineConfig({
        base: '/vibe-template/',
        title: 'vibe-template',
        cleanUrls: true,
        lastUpdated: true,
        ignoreDeadLinks: false,
        // Mermaid 12 за замовчуванням перекладає діаграми ELK і фарбує в redux-color / neo.
        // Тримаємо вигляд Mermaid 11; темну тему плагін і далі ставить сам.
        mermaid: { layout: 'dagre', theme: 'default', look: 'classic' },
        head: [
            ['link', { rel: 'icon', href: '/vibe-template/logo.svg' }],
            ['meta', { name: 'author', content: `${author} <${authorEmail}>` }],
            ['meta', { name: 'creator', content: author }],
            ['meta', { name: 'publisher', content: author }],
            ['meta', { property: 'og:site_name', content: 'vibe-template' }],
            ['meta', { property: 'og:type', content: 'website' }],
            ['meta', { property: 'article:author', content: author }],
            ['link', { rel: 'author', href: '/vibe-template/reference/author' }],
        ],
        themeConfig: {
            logo: '/logo.svg',
            socialLinks: [{ icon: 'github', link: repoUrl }],
            search: {
                provider: 'local',
                options: {
                    locales: {
                        en: {
                            translations: {
                                button: { buttonText: 'Search', buttonAriaLabel: 'Search' },
                                modal: {
                                    noResultsText: 'No results for',
                                    resetButtonTitle: 'Reset search',
                                    footer: {
                                        selectText: 'to select',
                                        navigateText: 'to navigate',
                                        closeText: 'to close',
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        locales: {
            root: {
                label: 'Українська',
                lang: 'uk-UA',
                description: ukDescription,
                head: [['script', { type: 'application/ld+json' }, jsonLd(ukDescription)]],
                themeConfig: {
                    nav: uk.nav,
                    sidebar: uk.sidebar,
                    footer: {
                        message: `Автор: ${author} · <a href="mailto:${authorEmail}">${authorEmail}</a>`,
                        copyright: `© ${String(new Date().getFullYear())} ${author}`,
                    },
                    editLink: {
                        pattern: `${repoUrl}/edit/main/documentation/:path`,
                        text: 'Редагувати сторінку на GitHub',
                    },
                    outline: { label: 'На цій сторінці' },
                    docFooter: { prev: 'Попередня', next: 'Наступна' },
                    lastUpdated: { text: 'Оновлено' },
                    langMenuLabel: 'Мова',
                    returnToTopLabel: 'Нагору',
                    sidebarMenuLabel: 'Меню',
                    darkModeSwitchLabel: 'Тема',
                    lightModeSwitchTitle: 'Світла тема',
                    darkModeSwitchTitle: 'Темна тема',
                },
            },
            en: {
                label: 'English',
                lang: 'en-US',
                link: '/en/',
                description: enDescription,
                head: [['script', { type: 'application/ld+json' }, jsonLd(enDescription)]],
                themeConfig: {
                    nav: en.nav,
                    sidebar: en.sidebar,
                    footer: {
                        message: `Author: ${author} · <a href="mailto:${authorEmail}">${authorEmail}</a>`,
                        copyright: `© ${String(new Date().getFullYear())} ${author}`,
                    },
                    editLink: {
                        pattern: `${repoUrl}/edit/main/documentation/:path`,
                        text: 'Edit this page on GitHub',
                    },
                    outline: { label: 'On this page' },
                    docFooter: { prev: 'Previous', next: 'Next' },
                    lastUpdated: { text: 'Updated' },
                    langMenuLabel: 'Language',
                    returnToTopLabel: 'Back to top',
                    sidebarMenuLabel: 'Menu',
                    darkModeSwitchLabel: 'Theme',
                    lightModeSwitchTitle: 'Switch to light theme',
                    darkModeSwitchTitle: 'Switch to dark theme',
                },
            },
        },
    }),
)

// mermaid тягне CJS-залежності (dayjs, fastdom...), які pnpm не піднімає, тож у dev
// бандлимо його цілком. withMermaid дописує ці залежності в include голими іменами,
// а під pnpm Vite їх не знаходить і пише "Failed to resolve dependency" — прибираємо їх.
config.vite = {
    ...config.vite,
    optimizeDeps: { ...config.vite?.optimizeDeps, include: ['mermaid'] },
}

export default config
