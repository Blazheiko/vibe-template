# feat-217 Landing Package — progress

Branch: `feat/landing`. Plan: [docs/plan/landing-plan.md](docs/plan/landing-plan.md) (редакція 5, рішення Р1–Р7 погоджено 2026-11-14).

## State (2026-11-14)

Кроки 2–11 плану виконано, крок 12 (ручна перевірка) — частково, див. «Not verified». Фіча готова до review.

### Що зроблено

- **Пакет `packages/landing`.** Vue 3 + Vite без клієнтського entry:
    - `src/entry-server.ts` рендерить сторінки і для пререндеру, і для dev (SSR middleware у `build/landing-plugin.ts`);
    - три мови (`/`, `/uk/`, `/pl/`), `404.html`, `sitemap.xml`, `robots.txt`;
    - production HTML без `<script>`;
    - тексти в `src/content/*` зі спільним типом, стилі в `src/styles/*.css`, `<style>` у SFC заборонено ESLint.
- **Контракт адрес** (`build/urls.ts`, `build/load-urls.ts`):
    - `LANDING_APP_URL` (дефолт: `FRONTEND_URL` з backend `.env`) і `LANDING_SITE_URL` (дефолт: `LANDING_URL`);
    - однаковий origin — помилка збірки, і повідомлення називає джерело значень;
    - строгий режим лише при `LANDING_STRICT=true`: https, без localhost і доменів RFC 2606.
- **Перевірка `dist/`** (`build/verify-dist.ts`) виконується в кінці кожного `vite build`.
- **`LANDING_URL` перепризначено** на адресу лендінгу. Поле `landingUrl` прибрано з `packages/backend/src/config/app.ts`, бо його ніхто не читав. Оновлено `.env.example` і `docs/configuration` обома мовами. З `docker-compose.yml` змінну прибрано, бо бекенд її не читає.
- **Локальні режими:**
    - `make dev` запускає лендінг на `:5175`; є також `make dev-landing`, `build-landing`, `preview-landing`, `test-e2e-landing`;
    - `make prod-local` збирає лендінг і запускає `vite preview` на `:4174`. Лендінг вмикає `PROD_LOCAL_LANDING=true`, тож frontend e2e запускаються без нього;
    - compose: сервіс `landing` (профіль `app`, `127.0.0.1:${LANDING_PORT:-8080}`, healthcheck `/healthz`), образ `vibe-template-landing:local` з `scripts/docker-build.sh`.
- **Docker:**
    - `packages/landing/Dockerfile`: node 24.22.2 → `nginx-unprivileged` 1.29, обидва образи закріплено digest-ом;
    - build-arg для адрес обов'язкові, `LANDING_STRICT=true` за замовчуванням;
    - `nginx/default.conf`: справжній 404, `immutable` для `/assets/`, відносний редирект, `/healthz`;
    - `nginx/security-headers.conf`: CSP без скриптів та інші заголовки.
- **`scripts/verify-landing-deploy.sh`** — curl-перевірка розгорнутого сайту, 78 перевірок.
- **`verify-compose.mjs`** перевіряє сервіс `landing`.
- **CI:** job `e2e` збирає лендінг і запускає його Playwright smoke.
- **Документація:**
    - `documentation/landing/index.md` + `en/`, сайдбари і `KEY_PAGES`;
    - getting-started, project-structure, reference/make, reference/scripts, backend/configuration, backend/deployment (обома мовами);
    - README, AGENTS.md.

### Відхилення від плану (свідомі)

- **Сторінка документації** лежить у `documentation/landing/` (як `/playground/` і `/frontend/` у розділі «Пакети»), а не в `guide/landing.md`.
- **Dev-порт лендінгу 5175**, а не 5174: на 5174 уже працює `api-playground` (`make dev-playground`).
- **Окремого скрипта `verify-dist` немає.** Перевірка вбудована в `vite build`: зламаний `dist/` не можна зібрати ні в CI, ні в Docker. Строгий режим збірки й перевірки вмикає та сама `LANDING_STRICT=true`.
- **Список доменів-заглушок** у строгому режимі ширший за план: `example.com`, `.net`, `.org` (RFC 2606), бо документація використовує `app.example.com`.
- **Маршрути винесено в `src/routes.ts` без текстів.** Інакше тексти ставали залежністю `vite.config.ts`, і Vite перезапускав dev-сервер на кожну правку тексту, замість того щоб перезавантажити сторінку.

## Evidence of Completion

- `make check` (format, typecheck, lint, verify-makefile, verify-compose, test) — **зелений**: backend 2983, frontend 607, api-playground 115, landing 46.
- `pnpm --filter landing test:e2e` — 36/36 (Chromium, без JavaScript, мобільний), тричі поспіль. Один перший прогін упав, але відтворити не вдалося; причину не знайдено.
- `pnpm docs:build && pnpm docs:verify` — зелені.
- **Прототип рендерингу (крок 2):**
    - dev: `/`, `/uk/`, `/pl/` → 200, `/uk` → 301, невідомий шлях → 404;
    - у Chromium зміна CSS застосовується без перезавантаження (маркер у `window` зберігся);
    - зміна тексту перезавантажує сторінку з новим текстом, без перезапуску сервера;
    - без хука `hotUpdate` перезавантаження не відбувається (перевірено).
- **`make prod-local`:** лендінг `:4174` → кнопки на `http://localhost:3000/register`; зупинка бекенду зупиняє preview.
- **Docker:**
    - збірка без build-arg падає з підказкою;
    - строгий режим відхиляє `http://localhost:3000`;
    - nginx: 200 на трьох сторінках, 404 з `404.html` і заголовками безпеки, `/uk` → `Location: /uk/`, uid `nginx`, healthy.
- **`make app-build && make app-up`:** `app` і `landing` healthy. `scripts/verify-landing-deploy.sh --allow-local http://localhost:8080 http://localhost:3000` — 78/78. Без `--allow-local` падає на http/localhost, з неправильним origin застосунку — теж.
- **Golden path у браузері:** `localhost:8080/uk/` → «Увійти» → `localhost:3000/login` з модалкою входу; «Зареєструватися» → `/register` з модалкою реєстрації (скриншот).

### Not verified

- Lighthouse (Performance/SEO/Accessibility ≥ 95) не запускався: його немає в репозиторії.
- Деплой за HTTPS-проксі — це `feat-218`.

## Notes for Next Session

- Локальний `packages/backend/.env` власника все ще містить старе `LANDING_URL=http://localhost:5173`. Через нього `pnpm build`, `./init.sh` і `make dev` (лендінг) зупиняються з помилкою «same origin». Потрібно змінити рядок на `LANDING_URL=http://localhost:5175`. Документація описує це в tip на сторінці лендінгу.
- Наступна фіча — `feat-218` (production-compose і Dokploy), залежить від цієї.
