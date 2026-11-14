import type { LandingContent } from './types'

export const en: LandingContent = {
    languageName: 'English',
    tagline: 'Full-stack TypeScript template',
    description:
        'A full-stack TypeScript template with a Vue 3 frontend, a uWebSockets.js backend and shared contracts: authentication, real-time, push notifications and a PWA are ready on day one.',
    nav: {
        label: 'Main',
        features: 'Features',
        stack: 'Stack',
        start: 'Get started',
        docs: 'Documentation',
        language: 'Language',
    },
    hero: {
        eyebrow: 'Open-source project template',
        title: 'Start your product from a working full-stack app',
        login: 'Log in',
        register: 'Sign up',
    },
    features: {
        title: 'What is already done',
        lead: 'The plumbing most products need on day one, wired together and tested.',
        items: [
            {
                title: 'Authentication',
                text: 'Email, phone (SMS) and social sign-in, sessions, CSRF protection and throttling.',
            },
            {
                title: 'Real-time',
                text: 'A WebSocket layer on uWebSockets.js for live updates, presence and messaging.',
            },
            {
                title: 'Push notifications',
                text: 'Server-side delivery of web push notifications to subscribed devices.',
            },
            {
                title: 'Installable PWA',
                text: 'The frontend installs like an app and keeps working offline.',
            },
            {
                title: 'Storage and email',
                text: 'File uploads to S3-compatible storage and transactional email.',
            },
            {
                title: 'Type-safe contracts',
                text: 'Schemas, responses and guards shared by the frontend and the backend.',
            },
            {
                title: 'AI integrations',
                text: 'AI providers with usage accounting and an AI support assistant.',
            },
            {
                title: 'Observability',
                text: 'Structured logs, health and readiness checks, error monitoring with Sentry.',
            },
        ],
    },
    stack: {
        title: 'Stack',
        lead: 'Current, typed tools in one pnpm workspace.',
        items: [
            { title: 'Vue 3', text: 'Composition API, Pinia, Vue Router, vue-i18n, Vite.' },
            { title: 'uWebSockets.js', text: 'HTTP and WebSocket server in TypeScript.' },
            { title: 'PostgreSQL', text: 'Drizzle ORM with migrations and pgvector.' },
            { title: 'Redis', text: 'Sessions, rate limits and shared state.' },
            { title: 'TypeScript 6', text: 'Strict types from the database to the browser.' },
            { title: 'Tests', text: 'Vitest, Playwright and CI on every pull request.' },
        ],
    },
    audience: {
        title: 'Best suited for',
        items: [
            'SaaS dashboards and account-based products',
            'Real-time apps: chats, live feeds, collaboration tools',
            'Internal tools that need sign-in and notifications',
            'Learning how a production-grade full-stack app fits together',
        ],
    },
    start: {
        title: 'Get started',
        lead: 'Clone the repository and run the whole app locally in a few commands.',
        steps: [
            { title: 'make setup', text: 'Checks the tools, installs dependencies, creates .env.' },
            {
                title: 'make services-up',
                text: 'Starts PostgreSQL, Redis, S3 and Mailpit in Docker.',
            },
            { title: 'make dev', text: 'Runs the backend, the app and this landing page.' },
        ],
        docs: 'Read the documentation',
        repository: 'Open the repository',
    },
    cta: {
        title: 'Try the app',
        text: 'Create an account or sign in to see the template in action.',
    },
    footer: {
        label: 'Footer',
        privacy: 'Privacy policy',
        terms: 'Terms',
        docs: 'Documentation',
        repository: 'GitHub',
    },
    notFound: {
        title: 'Page not found',
        text: 'There is no page at this address.',
        home: 'Go to the home page',
    },
}
