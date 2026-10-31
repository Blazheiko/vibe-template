import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const repoUrl = 'https://github.com/Blazheiko/vibe-template'
const author = 'Олександр Блажейко'
const authorEmail = 'blazheiko@gmail.com'

const packagesItems = [
    { text: 'Пакет shared', link: '/shared/' },
    { text: 'Фронтенд', link: '/frontend/' },
    { text: 'API Playground', link: '/playground/' },
]

const config = withMermaid(
    defineConfig({
        base: '/vibe-template/',
        lang: 'uk-UA',
        title: 'vibe-template',
        description:
            'Документація full-stack TypeScript шаблону: Vue 3, uWebSockets.js, shared контракти',
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
            [
                'script',
                { type: 'application/ld+json' },
                JSON.stringify({
                    '@context': 'https://schema.org',
                    '@type': 'WebSite',
                    name: 'vibe-template',
                    url: 'https://blazheiko.github.io/vibe-template/',
                    author: {
                        '@type': 'Person',
                        name: author,
                        email: `mailto:${authorEmail}`,
                        url: 'https://github.com/Blazheiko',
                    },
                }),
            ],
        ],
        themeConfig: {
            logo: '/logo.svg',
            nav: [
                { text: 'Почати навчання', link: '/guide/introduction' },
                { text: 'Бекенд', link: '/backend/' },
                {
                    text: 'Пакети',
                    items: [
                        { text: 'shared', link: '/shared/' },
                        { text: 'Фронтенд', link: '/frontend/' },
                        { text: 'API Playground', link: '/playground/' },
                    ],
                },
                { text: 'Довідник', link: '/reference/scripts' },
            ],
            sidebar: {
                '/guide/': [
                    {
                        text: 'Перший день',
                        items: [
                            { text: '1. Вступ', link: '/guide/introduction' },
                            { text: '2. Швидкий старт', link: '/guide/getting-started' },
                            { text: '3. Як влаштований бекенд', link: '/guide/how-backend-works' },
                            { text: '4. Перший маршрут', link: '/guide/first-endpoint' },
                            { text: '5. Як додати фічу', link: '/backend/adding-a-feature' },
                            { text: '6. Свій проєкт на шаблоні', link: '/guide/your-project' },
                        ],
                    },
                    {
                        text: 'Гайд',
                        items: [
                            { text: 'Структура проєкту', link: '/guide/project-structure' },
                            { text: 'Процес роботи', link: '/guide/workflow' },
                            { text: 'CSRF простими словами', link: '/guide/csrf' },
                        ],
                    },
                ],
                '/backend/': [
                    {
                        text: 'Бекенд',
                        items: [
                            {
                                text: 'Як влаштований (для новачків)',
                                link: '/guide/how-backend-works',
                            },
                            { text: 'Огляд', link: '/backend/' },
                            { text: 'Архітектура', link: '/backend/architecture' },
                            { text: 'Життєвий цикл запиту', link: '/backend/request-lifecycle' },
                            { text: 'Конфігурація', link: '/backend/configuration' },
                            { text: 'Контролери', link: '/backend/controllers' },
                            { text: 'Сервіси', link: '/backend/services' },
                            { text: 'Репозиторії', link: '/backend/repositories' },
                            { text: 'Трансформери', link: '/backend/transformers' },
                            { text: 'Валідація', link: '/backend/validation' },
                            { text: 'Перевірка відповідей', link: '/backend/response-validation' },
                            { text: 'Маршрутизація', link: '/backend/routing' },
                            { text: 'Middleware', link: '/backend/middlewares' },
                            { text: 'База даних', link: '/backend/database' },
                            { text: 'Автентифікація', link: '/backend/auth' },
                            { text: 'Вхід через соцмережі', link: '/backend/oauth' },
                            { text: 'Безпека', link: '/backend/security' },
                            { text: 'WebSocket', link: '/backend/websocket' },
                            { text: 'Тестування', link: '/backend/testing' },
                            { text: 'Кешування та ETag', link: '/backend/caching-etag' },
                            { text: 'Observability', link: '/backend/observability' },
                            { text: 'Деплой', link: '/backend/deployment' },
                        ],
                    },
                    {
                        text: 'Інтеграції',
                        items: [
                            { text: 'Сховище файлів (S3)', link: '/backend/storage' },
                            { text: 'Пошта', link: '/backend/mail' },
                            { text: 'Web Push сповіщення', link: '/backend/web-push-notification' },
                            { text: 'AI-інтеграції', link: '/backend/ai' },
                        ],
                    },
                    {
                        text: 'Туторіали',
                        items: [{ text: 'Як додати фічу', link: '/backend/adding-a-feature' }],
                    },
                ],
                '/shared/': [{ text: 'Пакети', items: packagesItems }],
                '/frontend/': [{ text: 'Пакети', items: packagesItems }],
                '/playground/': [{ text: 'Пакети', items: packagesItems }],
                '/reference/': [
                    {
                        text: 'Довідник',
                        items: [
                            { text: 'Скрипти', link: '/reference/scripts' },
                            { text: 'Toolchain', link: '/reference/toolchain' },
                            { text: 'Глосарій', link: '/reference/glossary' },
                            { text: 'Ролі та можливості', link: '/reference/roles-capabilities' },
                            { text: 'Про автора', link: '/reference/author' },
                        ],
                    },
                ],
            },
            footer: {
                message: `Автор: ${author} · <a href="mailto:${authorEmail}">${authorEmail}</a>`,
                copyright: `© ${String(new Date().getFullYear())} ${author}`,
            },
            search: { provider: 'local' },
            editLink: {
                pattern: `${repoUrl}/edit/main/documentation/:path`,
                text: 'Редагувати сторінку на GitHub',
            },
            socialLinks: [{ icon: 'github', link: repoUrl }],
            outline: { label: 'На цій сторінці' },
            docFooter: { prev: 'Попередня', next: 'Наступна' },
            lastUpdated: { text: 'Оновлено' },
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
