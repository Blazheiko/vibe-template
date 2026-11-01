# Вхід через соцмережі

Користувач може увійти через акаунт у соцмережі замість пароля. Бекенд підтримує чотири провайдери: **Google**, **Facebook**, **GitHub** і **GitLab**. Протокол OAuth 2.0 реалізує бібліотека [`arctic`](https://arcticjs.dev/). Код: [`config/oauth.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/oauth.ts), [`oauth-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/oauth-service.ts), [`oauth-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/auth/oauth-controller.ts).

::: info Кнопки у фронтенді
Фронтенд показує кнопки **лише налаштованих** провайдерів: компонент [`SocialAuthButtons.vue`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/components/SocialAuthButtons.vue) один раз завантажує список з `GET /api/auth/oauth/providers`. Якщо жоден провайдер не налаштовано, блоку «або увійдіть через» немає зовсім.
:::

## Як це працює

Маршрути лежать у групі `auth/oauth` з middleware `session_web` і `csrf_guard` (на `GET` CSRF не перевіряється, тож редиректи від провайдера проходять).

| Маршрут                                  | Що робить                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/auth/oauth/providers`          | список налаштованих провайдерів: `{ status: 'ok', providers: ['google', …] }`; без входу           |
| `GET /api/auth/oauth/:provider/redirect` | генерує `state` (і PKCE-`codeVerifier` для Google), кладе їх у сесію, `302` на сторінку провайдера |
| `GET /api/auth/oauth/:provider/callback` | сюди провайдер повертає користувача з `code` і `state`; бекенд логінить і робить `302` на фронтенд |

```mermaid
sequenceDiagram
    participant B as Браузер
    participant API as Бекенд
    participant P as Провайдер (Google…)
    B->>API: GET /api/auth/oauth/google/redirect
    API->>API: state, codeVerifier → сесія
    API-->>B: 302 → accounts.google.com?...&state=...
    B->>P: користувач дозволяє доступ
    P-->>B: 302 → /api/auth/oauth/google/callback?code=...&state=...
    B->>API: GET callback (з cookie сесії)
    API->>API: звірити state з сесією
    API->>P: обміняти code на access token
    API->>P: отримати профіль (id, email, ім'я, аватар)
    API->>API: знайти або створити користувача, auth.login()
    API-->>B: 302 → OAUTH_FRONTEND_SUCCESS_URL
```

Що відбувається в callback ([`oauthService.handleCallback`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/oauth-service.ts)):

1. **Перевірка `state`.** Значення з query порівнюється з тим, що збережено в сесії на кроці redirect. Розбіжність — `OAuth state mismatch`: так відсікається підроблений callback (CSRF на вході). Після callback `oauthState` і `oauthCodeVerifier` видаляються з сесії.
2. **Обмін `code` на токени** через `arctic` і запит профілю до API провайдера. Токен доступу використовується **один раз**, для цього запиту, і далі не зберігається (див. [нижче](#що-зберігається)). Facebook отримує токен у заголовку `Authorization: Bearer`, а не в query-рядку: у URL він потрапляє в логи проксі й CDN та в `Referer`.
3. **Email обов'язковий.** Якщо провайдер не віддав email, вхід не відбувається (`Could not retrieve email from provider`). Email приводиться до нижнього регістру. Разом з email бекенд визначає, чи провайдер **підтверджує**, що адреса належить користувачу (`emailVerified`, див. [нижче](#прив-язка-за-email)).
4. **Пошук користувача** в такому порядку:
    - є запис у `oauth_accounts` з цим провайдером і id користувача в провайдера → це той самий користувач, він входить без жодних записів в `oauth_accounts`;
    - інакше є користувач з таким email → до нього **прив'язується** новий OAuth-акаунт, але **лише якщо email підтверджений провайдером**. Інакше вхід відхиляється з причиною `oauth_email_unverified`;
    - інакше створюється новий користувач без пароля (`password: null`) з ім'ям і аватаром із профілю. Якщо email підтверджений провайдером, у користувача одразу заповнюється `emailVerifiedAt`.
5. **Вхід.** Викликається `auth.login(...)` — та сама функція, що й при вході за паролем (див. [Автентифікація](/backend/auth#вхід-і-вихід-у-коді)): нова сесія, нова cookie. Користувач отримує push «новий вхід».
6. **Редирект на фронтенд**: успіх — `OAUTH_FRONTEND_SUCCESS_URL` (`/?oauth=success`), будь-яка помилка — `OAUTH_FRONTEND_ERROR_URL` (`/?error=oauth_failed`), завжди зі статусом `302`. Для відмови в прив'язці до URL додається `reason=oauth_email_unverified`, і сторінка входу показує «An account with this email already exists. Sign in with your password.». Для решти помилок — загальне повідомлення.

## Що зберігається

Таблиця `oauth_accounts` тримає `provider`, `provider_user_id`, `provider_email`, `provider_name`, `provider_avatar` і час створення/зміни. Пара `provider` + `provider_user_id` унікальна. **Токени провайдера (`access_token`, `refresh_token`) не зберігаються**: жоден код їх не читав, а токен у відкритому вигляді в БД — це ризик без користі (витік бекапу чи дампу віддає доступ до акаунтів у провайдерів). Колонки видалено міграцією `drop_oauth_tokens`; вони були nullable, тож відкат — `ADD COLUMN access_token text, ADD COLUMN refresh_token text` (дані, що там були, не відновлюються).

Якщо вам потрібен доступ до API провайдера від імені користувача (офлайн), токени треба зберігати **зашифрованими** ключем, окремим від `APP_KEY`, і лише тоді, коли для цього є код, що їх читає.

### Що потрапляє в логи

Email і ім'я з профілю — персональні дані. Журнал OAuth-входу містить провайдера і **замаскований** email (`u***r@e*****e.com`, `maskEmailForLogs`), без імені, без id у провайдера і без токенів.

## Прив'язка за email

Якщо користувач з таким email уже є, а OAuth-акаунт ще не прив'язаний, бекенд прив'язує його **лише тоді, коли провайдер підтверджує email**. Інакше будь-хто міг би зареєструвати в провайдера чужу адресу і через неї увійти в чужий акаунт.

| Провайдер | Звідки береться підтвердження                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Google    | поле `verified_email` з `/oauth2/v2/userinfo`                                                                                   |
| GitHub    | адреса завжди береться з `/user/emails`: основна (`primary`) і підтверджена (`verified`); інших GitHub-адрес бекенд не бере     |
| GitLab    | claim `email_verified` з OpenID Connect (`/oauth/userinfo`, scopes `openid email`) для тієї самої адреси, що й у `/api/v4/user` |
| Facebook  | **ніколи**: Graph API не має ознаки «email підтверджено» (поле `verified` стосується акаунта, а не адреси)                      |

Що з цього випливає:

- Користувач, який зареєструвався паролем, не зможе **вперше** увійти через Facebook з тим самим email: він побачить повідомлення «увійдіть паролем». Прив'язки соцмереж з налаштувань акаунта поки немає.
- Новий користувач через Facebook створюється, але з непідтвердженим email.
- Уже прив'язані акаунти (запис у `oauth_accounts`) входять як раніше: перевірка стосується лише нової прив'язки.
- Відмова видна в логах як `oauth link refused: email not verified by provider`.

## Що потрібно, щоб це запрацювало

### 1. Зареєструвати застосунок у провайдера

У консолі розробника кожного провайдера створіть OAuth-застосунок і отримайте **Client ID** і **Client Secret**.

| Провайдер | Де створити                                                                                                    | Які дозволи запитує бекенд            |
| --------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Google    | [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), тип «Web application» | `openid`, `profile`, `email` (+ PKCE) |
| Facebook  | [Meta for Developers](https://developers.facebook.com/apps/), продукт «Facebook Login»                         | `email`, `public_profile`             |
| GitHub    | [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers)                  | `user:email`                          |
| GitLab    | [GitLab → Preferences → Applications](https://gitlab.com/-/user_settings/applications)                         | `openid`, `email`, `read_user`        |

GitLab підключено до `https://gitlab.com`. Для власного інстансу GitLab змініть адресу в `createGitLabClient()` і `fetchGitLabUserInfo()`.

::: warning GitLab: увімкніть scopes `openid` і `email`
Бекенд запитує в GitLab `openid`, `email` і `read_user`: ознаку підтвердження email (`email_verified`) GitLab віддає лише через OpenID Connect. У налаштуваннях OAuth-застосунку GitLab (**Preferences → Applications** → ваш застосунок) мають бути позначені всі три scopes.

Якщо застосунок створено раніше лише з `read_user`, **оновіть його до деплою цієї версії**: інакше GitLab відхилить авторизацію з помилкою `invalid_scope`, і вхід через GitLab перестане працювати. Деталі — [GitLab як OpenID Connect provider](https://docs.gitlab.com/integration/openid_connect_provider/).
:::

### 2. Вказати Redirect URI

У налаштуваннях застосунку провайдера додайте **Authorized redirect URI**. Він має вести на callback бекенду і **точно** збігатися з тим, що в `.env`:

```text
https://app.example.com/api/auth/oauth/<provider>/callback
```

Провайдер поверне браузер саме на цю адресу, і браузер має надіслати туди cookie сесії, створеної на кроці redirect. Тому домен у Redirect URI — той, на якому користувач відкрив застосунок.

::: tip Локальна розробка
У dev фронтенд працює на `http://localhost:5173`, а Vite проксіює `/api` на бекенд. Вказуйте Redirect URI через порт фронтенду: `http://localhost:5173/api/auth/oauth/google/callback`. Якщо вказати `:3000`, cookie сесії з `:5173` туди не дійде і вхід завершиться `Missing OAuth parameters`. Google і GitHub дозволяють `http://localhost`; Facebook вимагає HTTPS для всього, крім `localhost`.
:::

### 3. Заповнити `.env`

```bash
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_REDIRECT_URI=http://localhost:5173/api/auth/oauth/google/callback

# куди повернути користувача після входу (необов'язково)
OAUTH_FRONTEND_SUCCESS_URL=/?oauth=success
OAUTH_FRONTEND_ERROR_URL=/?error=oauth_failed
```

Так само для `FACEBOOK_*`, `GITHUB_*` і `GITLAB_*`. Повний список змінних — [Конфігурація → OAuth](/backend/configuration#oauth). Client Secret — секрет: не комітьте його.

Перезапустіть бекенд і відкрийте `http://localhost:5173/api/auth/oauth/google/redirect` — вас має перекинути на сторінку входу Google.

::: info Ненастроєний провайдер
Провайдер вважається налаштованим, коли задано всі три змінні: `*_CLIENT_ID`, `*_CLIENT_SECRET` і `*_REDIRECT_URI`. Ненастроєного провайдера немає в `GET /api/auth/oauth/providers`, тож і кнопки для нього немає, а прямий перехід на `/api/auth/oauth/<provider>/redirect` повертає `404 Provider not configured`.
:::

### Типові помилки

Усі помилки callback ведуть на `OAUTH_FRONTEND_ERROR_URL` (статус `302`); причину видно в логах бекенду (`oauth callback failed`).

| Повідомлення в логах                                 | Причина                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Missing OAuth parameters`                           | у callback немає `code`/`state` або в сесії немає `oauthState` (інший домен, інший браузер, сесія протермінувалась, користувач скасував вхід)                        |
| `OAuth state mismatch`                               | `state` не збігся: старе посилання або callback з чужої сесії                                                                                                        |
| `OAuth code exchange failed`                         | невірний Client Secret, Redirect URI не збігається з зареєстрованим, `code` уже використаний                                                                         |
| `oauth provider returned empty email`                | користувач не дав доступу до email або в нього немає підтвердженої адреси                                                                                            |
| `oauth link refused: email not verified by provider` | користувач з таким email уже є, а провайдер не підтверджує адресу (див. [Прив'язка за email](#прив-язка-за-email)); фронтенд отримує `reason=oauth_email_unverified` |
| `Provider not configured: <name>`                    | для провайдера не задано всі три змінні `*_CLIENT_ID`, `*_CLIENT_SECRET`, `*_REDIRECT_URI`                                                                           |
| `Unsupported provider: <name>`                       | у URL провайдер, якого немає в `SUPPORTED_PROVIDERS`                                                                                                                 |

## Як додати нового провайдера

Нижче приклад для **Discord**. `arctic` підтримує понад 50 провайдерів ([список](https://arcticjs.dev/)), і для кожного кроки однакові. Усі зміни бекенду — у двох файлах: `config/oauth.ts` і `oauth-service.ts`. Маршрути змінювати не треба: `:provider` у URL уже приймає будь-яке ім'я.

### 1. Конфіг і змінні оточення

[`config/oauth.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/oauth.ts):

```ts
discord: {
    clientId: env['DISCORD_CLIENT_ID'] ?? '',
    clientSecret: env['DISCORD_CLIENT_SECRET'] ?? '',
    redirectUri: env['DISCORD_REDIRECT_URI'] ?? '',
},
```

Додайте ці три змінні в `packages/backend/.env.example` і в таблицю на сторінці [Конфігурація](/backend/configuration#oauth).

### 2. Сервіс

У [`oauth-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/oauth-service.ts):

```ts
import { Discord /* , Google, ... */ } from 'arctic'

// 1. дозволити провайдера
const SUPPORTED_PROVIDERS = ['google', 'facebook', 'github', 'gitlab', 'discord'] as const

// 2. фабрика клієнта
function createDiscordClient(): Discord {
    return new Discord(
        oauthConfig.discord.clientId,
        oauthConfig.discord.clientSecret,
        oauthConfig.discord.redirectUri,
    )
}

// 3. профіль користувача → OAuthUserInfo
async function fetchDiscordUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const data = await fetchJson('https://discord.com/api/users/@me', {
        Authorization: `Bearer ${accessToken}`,
    })
    const id = typeof data['id'] === 'string' ? data['id'] : ''
    const avatarHash = typeof data['avatar'] === 'string' ? data['avatar'] : null
    return {
        id,
        email: typeof data['email'] === 'string' ? data['email'] : '',
        name:
            typeof data['global_name'] === 'string'
                ? data['global_name']
                : typeof data['username'] === 'string'
                  ? data['username']
                  : '',
        avatar:
            avatarHash !== null
                ? `https://cdn.discordapp.com/avatars/${id}/${avatarHash}.png`
                : null,
        // Discord повертає `verified`: чи підтверджено email. Без цього поля ставте false.
        emailVerified: data['verified'] === true,
    }
}
```

Поле `emailVerified` обов'язкове: воно вирішує, чи можна прив'язати вхід до наявного користувача з тим самим email (див. [Прив'язка за email](#прив-язка-за-email)). Якщо провайдер не дає надійної ознаки, ставте `false`, як для Facebook.

У `getAuthorizationUrl` додайте гілку перед GitLab (вона йде останньою як «інакше»):

```ts
if (provider === 'discord') {
    const url = createDiscordClient().createAuthorizationURL(state, null, ['identify', 'email'])
    return Result.ok({ url: url.toString(), state, codeVerifier: null })
}
```

У `handleCallback` — гілку обміну коду:

```ts
} else if (provider === 'discord') {
    const tokens = await createDiscordClient().validateAuthorizationCode(code, null)
    userInfo = await fetchDiscordUserInfo(tokens.accessToken())
}
```

Сигнатури `createAuthorizationURL` і `validateAuthorizationCode` у різних провайдерів відрізняються: одні вимагають PKCE (`codeVerifier`, як Google), інші ні (GitHub), у треті його можна передати або `null` (Discord). Дивіться сторінку провайдера в документації `arctic`. Якщо провайдер вимагає PKCE, згенеруйте `codeVerifier` через `generateCodeVerifier()` і поверніть його з `getAuthorizationUrl` — контролер збереже його в сесії, як для Google.

Решту робить спільний код: пошук або створення користувача, запис у `oauth_accounts` з `provider = 'discord'`, `auth.login` і редирект. Колонка `provider` має довжину 50 символів, тож міграція БД не потрібна.

### 3. Тип провайдера і фронтенд

Список провайдерів також є в спільному типі: додайте `'discord'` в `OAuthProviderSchema` у [`shared/src/responses/oauth-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/oauth-controller.ts). Тоді `GET /api/auth/oauth/providers` зможе його повернути.

У [`SocialAuthButtons.vue`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/components/SocialAuthButtons.vue) додайте назву в `LABELS` (TypeScript підкаже, бо `LABELS` має тип `Record<OAuthProvider, string>`) і за бажанням іконку:

```ts
const LABELS: Record<OAuthProvider, string> = {
    google: 'Google',
    // ...
    discord: 'Discord',
}
```

Окремо прописувати кнопку не треба: вона з'явиться сама, щойно на бекенді будуть задані змінні `DISCORD_*`. Посилання формує компонент (`/api/auth/oauth/discord/redirect`); це звичайне посилання, а не `fetch`, бо браузер має сам перейти на сторінку провайдера.

### 4. Перевірка

1. Зареєструйте застосунок у [Discord Developer Portal](https://discord.com/developers/applications), Redirect URI — `http://localhost:5173/api/auth/oauth/discord/callback`.
2. Заповніть `DISCORD_*` у `.env`, перезапустіть бекенд.
3. Переконайтесь, що `GET /api/auth/oauth/providers` повертає `discord`, натисніть кнопку, дозвольте доступ — вас поверне на `/?oauth=success` уже залогіненим. У таблиці `oauth_accounts` з'явиться рядок з `provider = 'discord'`.
4. Запустіть `pnpm --filter backend typecheck` і `pnpm --filter backend test`.
