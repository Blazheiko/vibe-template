# Лендінг

`packages/landing` — статична публічна сторінка шаблону: що це за проєкт, що в ньому вже є, стек і як почати. Кнопки «Увійти» і «Зареєструватися» ведуть на `/login` і `/register` застосунку, де frontend відкриває модалки входу й реєстрації ([router/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/router/index.ts)). Лендінг не звертається до API, не ставить cookie і не містить JavaScript.

## Як це влаштовано

- **Vue 3 + Vite без клієнтського entry.** Сторінки рендерить один модуль [`src/entry-server.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/src/entry-server.ts) через `renderToString` з `vue/server-renderer`.
    - `vite build` пререндерить кожну сторінку в статичний HTML.
    - Dev-сервер рендерить ту саму сторінку на кожен запит.
    - Розмітка в dev і в збірці однакова.
- **Три мови.** `en` на `/`, `uk` на `/uk/`, `pl` на `/pl/`. Кожна мова — окремий HTML з `lang`, `canonical`, `hreflang` (плюс `x-default` → `/`) і Open Graph. Перемикач мов — звичайні посилання.
- **Тексти** лежать у [`src/content/`](https://github.com/Blazheiko/vibe-template/tree/main/packages/landing/src/content): по файлу на мову, зі спільним типом `LandingContent`. Якщо в якійсь мові бракує ключа, це помилка `typecheck`. Назву продукту лендінг бере з `PRODUCT` ([`shared/product`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/product/index.ts)).
- **Стилі** — звичайні CSS-файли в [`src/styles/`](https://github.com/Blazheiko/vibe-template/tree/main/packages/landing/src/styles), підключені з `index.html`. Світла і темна тема перемикаються через `prefers-color-scheme`. Блок `<style>` у компоненті заборонений правилом ESLint: без клієнтського entry Vite не вставляє його в сторінку.
- **Не SPA.** Невідомий шлях — це 404 зі сторінкою `404.html`, а не головна сторінка з 200. Тому у Vite стоїть `appType: 'mpa'`.

## Адреси

Лендінг і застосунок живуть на різних origin, наприклад `https://example.com` і `https://app.example.com`. Один origin не підтримується: бекенд відповідає SPA на будь-який невідомий шлях, а service worker застосунку контролює `/`.

| Адреса                     | Змінна             | Звідки береться, якщо не задана                                          |
| -------------------------- | ------------------ | ------------------------------------------------------------------------ |
| Куди ведуть кнопки         | `LANDING_APP_URL`  | `FRONTEND_URL` з `packages/backend/.env`, інакше `http://localhost:5173` |
| Публічна адреса лендінгу   | `LANDING_SITE_URL` | `LANDING_URL` з `packages/backend/.env`, інакше `http://localhost:5175`  |
| Публічна адреса застосунку | `PRODUCT.siteUrl`  | задається в коді; лендінг її **не** змінює і не читає                    |

Обидві змінні лендінгу — це origin без шляху і без `/` у кінці. Їх читає [`build/urls.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/build/urls.ts) під час збірки, і вони вшиваються в HTML. Власного `.env` у лендінгу немає.

**Строгий режим** вмикає лише явне `LANDING_STRICT=true`, від режиму Vite він не залежить. У строгому режимі збірка відмовляє, якщо будь-яка з адрес:

- не використовує `https`;
- має хост, записаний не як звичайне ASCII-доменне ім'я: IP-адреса в будь-якій формі (`[::1]`, `127.0.0.1`, `2130706433`, `127.1`), `%`, не-ASCII символи, `\` чи пробіли;
- вказує на `localhost` чи `*.localhost`;
- є зарезервованим доменом з RFC 2606: `example.com`, `.net`, `.org`, `.example`, `.test`, `.invalid`.

Кінцева крапка DNS (`example.com.`) перевірку не обходить: перед порівнянням її відкидають.

Правило таке суворе, бо браузер нормалізує хост: для нього `2130706433` і `local%68ost` — це `localhost`. Shell-скрипт перевірки деплою так нормалізувати не вміє. Тому обидва валідатори приймають лише хост, який уже записано у звичайній формі, і проганяють одну спільну таблицю випадків ([`address-rule.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/build/__tests__/address-rule.spec.ts)).

`LANDING_STRICT=false` або відсутня змінна дають звичайну локальну збірку. Будь-яке інше значення — помилка.

::: tip Помилка «same origin» на старому `.env`
До появи лендінгу `.env.example` задавав `LANDING_URL=http://localhost:5173`, тобто адресу SPA. Збірка лендінгу з таким `.env` зупиняється з повідомленням про однаковий origin. Виправте рядок на `LANDING_URL=http://localhost:5175`.
:::

## Запуск локально

| Режим                | Команда                                                         | Адреси                                                                            |
| -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Розробка             | `make dev` (разом із backend і frontend) або `make dev-landing` | лендінг `http://localhost:5175`, SPA `:5173`, API `:3000`                         |
| Production-подібний  | `make prod-local`                                               | лендінг `http://localhost:4174` (`vite preview`), застосунок `:3000`              |
| Збірка й перегляд    | `make build-landing`, потім `make preview-landing`              | `http://localhost:4174`                                                           |
| Усе в Docker Compose | `make app-build`, потім `make app-up`                           | лендінг `http://localhost:8080` (`LANDING_PORT`), застосунок `:3000` (`APP_PORT`) |

У dev-режимі зміни CSS застосовуються без перезавантаження сторінки. Зміна тексту чи компонента перезавантажує сторінку, і вона рендериться заново: плагін [`build/landing-plugin.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/build/landing-plugin.ts) стежить за SSR-модулями.

`make prod-local` збирає лендінг з кнопками на `http://localhost:<PORT>`. Бекенд стартує лише тоді, коли preview на `127.0.0.1:4174` віддав саме цей лендінг. Якщо порт зайнятий або лендінг зібрано під іншу адресу застосунку, запуск зупиняється з поясненням. Коли завершується один із двох процесів, скрипт зупиняє й другий. Скрипт frontend e2e викликають без лендінгу: його вмикає лише `PROD_LOCAL_LANDING=true`, яку ставить `pnpm prod:local`.

У compose лендінг — сервіс `landing` профілю `app`. Його образ збирає [`scripts/docker-build.sh`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/docker-build.sh) з кнопками на `http://localhost:APP_PORT`. Тому `APP_PORT` і `LANDING_PORT` треба змінювати до `make app-build`, а не після.

## Збірка і перевірки

`pnpm --filter landing build` виконує кроки по черзі:

1. `vue-tsc`.
2. SSR-збірка `entry-server.ts`.
3. Клієнтська збірка: лише `index.html` і CSS.
4. Пререндер у `dist/`: `index.html`, `uk/index.html`, `pl/index.html`, `404.html`, `sitemap.xml`, `robots.txt`.

Збірка завершується перевіркою `dist/` ([`build/verify-dist.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/build/verify-dist.ts)). Будь-яка проблема зупиняє збірку. Перевіряється, що:

- усі сторінки на місці, у кожної правильні `lang`, `canonical`, `hreflang` і `og:url`;
- обидві кнопки ведуть на `LANDING_APP_URL`;
- у HTML немає `<script>`, а CSS іде з `/assets/`;
- sitemap і robots вказують на `LANDING_SITE_URL`.

У строгому режимі до правил адрес також підпадають `<loc>` у sitemap, `Sitemap:` у robots, `canonical`, `hreflang`, `og:url` і кнопки. Namespace `xmlns="http://www.sitemaps.org/..."` адресою не вважається.

Тести:

- `pnpm --filter landing test` — Vitest: адреси, рендер, перевірка `dist/`.
- `make test-e2e-landing` — збирає лендінг і запускає Playwright на `vite preview` у трьох проєктах: Chromium, Chromium з вимкненим JavaScript і мобільний. Кнопки перевіряються за адресою, застосунок при цьому не запускається.

## Docker-образ

[`packages/landing/Dockerfile`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/Dockerfile) збирається з кореня репозиторію в два етапи: Node збирає `shared` і лендінг, а nginx (`nginx-unprivileged`, не від root, порт `8080`) віддає `dist/`.

```bash
docker build -f packages/landing/Dockerfile \
  --build-arg LANDING_APP_URL=https://app.example.com \
  --build-arg LANDING_SITE_URL=https://example.com \
  -t <registry>/landing:<tag> .
```

- `LANDING_APP_URL` і `LANDING_SITE_URL` обов'язкові: без них збірка зупиняється з підказкою.
- `LANDING_STRICT` за замовчуванням `true`. Локальний `docker-build.sh` передає `false`.
- nginx тільки віддає файли. TLS, домени й редиректи — справа проксі перед ним.
- Конфіг [`nginx/default.conf`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/nginx/default.conf):
    - справжній 404 з `404.html`;
    - кеш `immutable` для `/assets/`, `no-cache` для решти;
    - відносний редирект `/uk` → `/uk/`;
    - `/healthz` для healthcheck.
- Заголовки безпеки (CSP без скриптів, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) задає [`nginx/security-headers.conf`](https://github.com/Blazheiko/vibe-template/blob/main/packages/landing/nginx/security-headers.conf). HSTS ставить проксі з TLS.

Розгорнутий лендінг перевіряє [`scripts/verify-landing-deploy.sh`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/verify-landing-deploy.sh):

```bash
scripts/verify-landing-deploy.sh https://example.com https://app.example.com
scripts/verify-landing-deploy.sh --allow-local http://localhost:8080 http://localhost:3000   # локальний compose
```

Скрипт перевіряє:

- `/`, `/uk/` і `/pl/` відповідають 200;
- невідомий шлях повертає 404 саме зі сторінкою 404;
- заголовки безпеки;
- `canonical` і `hreflang` на адресі лендінгу, кнопки на адресі застосунку;
- sitemap і robots;
- `<app>/login` відповідає 200.

Без `--allow-local` кожна опублікована адреса (`canonical`, `hreflang`, `og:url`, `og:image`, кнопки) має бути публічною `https`, хоч би на який origin вона вказувала. `--resolve HOST:PORT:ADDR` (як у curl) перевіряє новий сервер ще до перемикання DNS, наприклад `--resolve example.com:443:203.0.113.10`.

::: warning План
Деплой усього застосунку разом із лендінгом на Hetzner через Dokploy (`docker-compose-prod.yml`, Traefik, домени, змінні) — фіча `feat-218`. Поки її не зроблено, образ лендінгу розгортається за будь-яким reverse proxy з TLS.
:::

### Інший хостинг

`packages/landing/dist/` — звичайна статика, тож її можна викласти на будь-який хостинг. Що перенести з `nginx/`:

- заголовки безпеки;
- `404.html` зі статусом 404, без SPA-rewrite;
- довгий кеш для `/assets/`.

Сайт має бути в корені домену: шляхи мов і `hreflang` абсолютні від `/`. Збирайте з `LANDING_STRICT=true` і перевіряйте результат `verify-landing-deploy.sh`. Цей шлях документація не тестує.

## Як змінити

- **Тексти:** `src/content/<мова>.ts`. Новий ключ додайте спершу в `types.ts`, і typecheck покаже мови, де його бракує.
- **Секції:** компоненти в `src/components/`, порядок задає `src/App.vue`.
- **Стилі:** `src/styles/tokens.css` (кольори, світла і темна тема), `layout.css`, `sections.css`.
- **Нова мова:** додайте її в `LOCALES` (`content/types.ts`) і шлях у `LOCALE_PATHS` (`src/routes.ts`), створіть словник і додайте його в `CONTENT` (`src/pages.ts`). Шлях також треба додати в перевірки `scripts/verify-landing-deploy.sh` і в e2e.
