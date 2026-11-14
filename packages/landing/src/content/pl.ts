import type { LandingContent } from './types'

export const pl: LandingContent = {
    languageName: 'Polski',
    tagline: 'Szablon full-stack w TypeScript',
    description:
        'Szablon full-stack w TypeScript: frontend w Vue 3, backend na uWebSockets.js i wspólne kontrakty. Uwierzytelnianie, real-time, powiadomienia push i PWA są gotowe od pierwszego dnia.',
    nav: {
        label: 'Menu główne',
        features: 'Funkcje',
        stack: 'Stos',
        start: 'Jak zacząć',
        docs: 'Dokumentacja',
        language: 'Język',
    },
    hero: {
        eyebrow: 'Szablon projektu open source',
        title: 'Zacznij produkt od działającej aplikacji full-stack',
        login: 'Zaloguj się',
        register: 'Zarejestruj się',
    },
    features: {
        title: 'Co jest już gotowe',
        lead: 'Infrastruktura potrzebna większości produktów od pierwszego dnia, połączona i przetestowana.',
        items: [
            {
                title: 'Uwierzytelnianie',
                text: 'Logowanie przez email, telefon (SMS) i serwisy społecznościowe, sesje, ochrona CSRF i limity.',
            },
            {
                title: 'Real-time',
                text: 'Warstwa WebSocket na uWebSockets.js do aktualizacji na żywo, obecności i wiadomości.',
            },
            {
                title: 'Powiadomienia push',
                text: 'Wysyłanie powiadomień web push z serwera na subskrybowane urządzenia.',
            },
            {
                title: 'PWA',
                text: 'Frontend instaluje się jak aplikacja i działa offline.',
            },
            {
                title: 'Pliki i poczta',
                text: 'Przesyłanie plików do magazynu zgodnego z S3 i wiadomości transakcyjne.',
            },
            {
                title: 'Typowane kontrakty',
                text: 'Schematy, odpowiedzi i guardy wspólne dla frontendu i backendu.',
            },
            {
                title: 'Integracje AI',
                text: 'Dostawcy AI z rozliczaniem użycia i asystent AI wsparcia.',
            },
            {
                title: 'Obserwowalność',
                text: 'Strukturalne logi, kontrole health i readiness, monitorowanie błędów przez Sentry.',
            },
        ],
    },
    stack: {
        title: 'Stos',
        lead: 'Nowoczesne, typowane narzędzia w jednym pnpm workspace.',
        items: [
            { title: 'Vue 3', text: 'Composition API, Pinia, Vue Router, vue-i18n, Vite.' },
            { title: 'uWebSockets.js', text: 'Serwer HTTP i WebSocket w TypeScript.' },
            { title: 'PostgreSQL', text: 'Drizzle ORM z migracjami i pgvector.' },
            { title: 'Redis', text: 'Sesje, limity zapytań i wspólny stan.' },
            { title: 'TypeScript 6', text: 'Ścisłe typy od bazy danych po przeglądarkę.' },
            { title: 'Testy', text: 'Vitest, Playwright i CI przy każdym pull requeście.' },
        ],
    },
    audience: {
        title: 'Dla kogo',
        items: [
            'Dashboardy SaaS i produkty z kontami użytkowników',
            'Aplikacje real-time: czaty, kanały na żywo, narzędzia do współpracy',
            'Narzędzia wewnętrzne, które potrzebują logowania i powiadomień',
            'Nauka: jak zbudowana jest aplikacja full-stack klasy produkcyjnej',
        ],
    },
    start: {
        title: 'Jak zacząć',
        lead: 'Sklonuj repozytorium i uruchom całą aplikację lokalnie kilkoma poleceniami.',
        steps: [
            {
                title: 'make setup',
                text: 'Sprawdza narzędzia, instaluje zależności, tworzy .env.',
            },
            {
                title: 'make services-up',
                text: 'Uruchamia PostgreSQL, Redis, S3 i Mailpit w Dockerze.',
            },
            { title: 'make dev', text: 'Uruchamia backend, aplikację i tę stronę.' },
        ],
        docs: 'Przeczytaj dokumentację',
        repository: 'Otwórz repozytorium',
    },
    cta: {
        title: 'Wypróbuj aplikację',
        text: 'Załóż konto lub zaloguj się, aby zobaczyć szablon w działaniu.',
    },
    footer: {
        label: 'Linki',
        privacy: 'Polityka prywatności',
        terms: 'Regulamin',
        docs: 'Dokumentacja',
        repository: 'GitHub',
    },
    notFound: {
        title: 'Nie znaleziono strony',
        text: 'Pod tym adresem nie ma strony.',
        home: 'Przejdź na stronę główną',
    },
}
