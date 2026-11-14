import type { LandingContent } from './types'

export const uk: LandingContent = {
    languageName: 'Українська',
    tagline: 'Full-stack шаблон на TypeScript',
    description:
        'Full-stack шаблон на TypeScript: фронтенд на Vue 3, бекенд на uWebSockets.js і спільні контракти. Автентифікація, real-time, push-сповіщення і PWA готові з першого дня.',
    nav: {
        label: 'Головне меню',
        features: 'Можливості',
        stack: 'Стек',
        start: 'Як почати',
        docs: 'Документація',
        language: 'Мова',
    },
    hero: {
        eyebrow: 'Шаблон проєкту з відкритим кодом',
        title: 'Почніть продукт із робочого full-stack застосунку',
        login: 'Увійти',
        register: 'Зареєструватися',
    },
    features: {
        title: 'Що вже зроблено',
        lead: 'Інфраструктура, яка потрібна більшості продуктів з першого дня, зібрана разом і покрита тестами.',
        items: [
            {
                title: 'Автентифікація',
                text: 'Вхід через email, телефон (SMS) і соцмережі, сесії, захист від CSRF і обмеження частоти.',
            },
            {
                title: 'Real-time',
                text: 'WebSocket на uWebSockets.js для живих оновлень, присутності й повідомлень.',
            },
            {
                title: 'Push-сповіщення',
                text: 'Серверна доставка web push-сповіщень на підписані пристрої.',
            },
            {
                title: 'PWA',
                text: 'Фронтенд встановлюється як застосунок і працює офлайн.',
            },
            {
                title: 'Сховище і пошта',
                text: 'Завантаження файлів у S3-сумісне сховище і транзакційні листи.',
            },
            {
                title: 'Типізовані контракти',
                text: 'Схеми, відповіді й guards, спільні для фронтенду і бекенду.',
            },
            {
                title: 'AI-інтеграції',
                text: 'AI-провайдери з обліком використання і AI-асистент підтримки.',
            },
            {
                title: 'Спостережуваність',
                text: 'Структуровані логи, перевірки health і readiness, моніторинг помилок через Sentry.',
            },
        ],
    },
    stack: {
        title: 'Стек',
        lead: 'Сучасні типізовані інструменти в одному pnpm workspace.',
        items: [
            { title: 'Vue 3', text: 'Composition API, Pinia, Vue Router, vue-i18n, Vite.' },
            { title: 'uWebSockets.js', text: 'HTTP- і WebSocket-сервер на TypeScript.' },
            { title: 'PostgreSQL', text: 'Drizzle ORM з міграціями і pgvector.' },
            { title: 'Redis', text: 'Сесії, ліміти запитів і спільний стан.' },
            { title: 'TypeScript 6', text: 'Строгі типи від бази даних до браузера.' },
            { title: 'Тести', text: 'Vitest, Playwright і CI на кожен pull request.' },
        ],
    },
    audience: {
        title: 'Кому підходить',
        items: [
            'SaaS-дашборди і продукти з обліковими записами',
            'Real-time застосунки: чати, живі стрічки, інструменти для спільної роботи',
            'Внутрішні інструменти, яким потрібні вхід і сповіщення',
            'Навчання: як влаштований full-stack застосунок production-рівня',
        ],
    },
    start: {
        title: 'Як почати',
        lead: 'Клонуйте репозиторій і запустіть увесь застосунок локально кількома командами.',
        steps: [
            {
                title: 'make setup',
                text: 'Перевіряє інструменти, встановлює залежності, створює .env.',
            },
            {
                title: 'make services-up',
                text: 'Запускає PostgreSQL, Redis, S3 і Mailpit у Docker.',
            },
            { title: 'make dev', text: 'Запускає бекенд, застосунок і цей лендінг.' },
        ],
        docs: 'Читати документацію',
        repository: 'Відкрити репозиторій',
    },
    cta: {
        title: 'Спробуйте застосунок',
        text: 'Створіть обліковий запис або увійдіть, щоб побачити шаблон у роботі.',
    },
    footer: {
        label: 'Посилання',
        privacy: 'Політика конфіденційності',
        terms: 'Умови використання',
        docs: 'Документація',
        repository: 'GitHub',
    },
    notFound: {
        title: 'Сторінку не знайдено',
        text: 'За цією адресою немає сторінки.',
        home: 'На головну',
    },
}
