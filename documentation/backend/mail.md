# Пошта

Бекенд надсилає листи через SMTP за допомогою [nodemailer](https://nodemailer.com/). Канал вимкнено, доки не задано змінні `SMTP_*`: їх перелік і значення за замовчуванням описані в [Конфігурації](/backend/configuration). Push-сповіщення описано окремо: [Web Push сповіщення](/backend/web-push-notification).

## Транспорт

Сервіс [`email-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/email-service.ts) створює один лінивий `nodemailer`-транспорт (`createTransport`) з `host`, `port`, `secure`, опційними `requireTLS`/`ignoreTLS` та `auth` (лише якщо задані і `SMTP_USER`, і `SMTP_PASSWORD`). Налаштування беруться з [`config/mail.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/mail.ts).

Публічний API — об'єкт `emailService`:

- `isConfigured(): boolean` — чи пройдена перевірка конфігурації;
- `send(input: SendEmailInput): Promise<AppResult<SendEmailOutput>>` — повертає `Result` (`better-result`), не кидає винятків.

`SendEmailInput` підтримує `to`, `cc`, `bcc`, `replyTo` (рядок, `{ email, name? }` або масив), `subject`, `text`/`html`, `from` та `attachments`. Якщо `from` не задано, використовується `SMTP_FROM_NAME <SMTP_FROM_EMAIL>`; якщо `replyTo` не задано — `SMTP_REPLY_TO` з конфігу.

## Поведінка, коли SMTP вимкнено

Пошта **не підміняється логуванням**. Перед кожною відправкою `send()` перевіряє конфігурацію і при помилці пише `logger.warn` та повертає `Result.err(internalMessage(...))`. Можливі причини:

- `Email service is disabled` — `SMTP_ENABLED` не `true`;
- `SMTP_HOST is not configured`;
- `SMTP_FROM_EMAIL is not configured`;
- `SMTP_USER and SMTP_PASSWORD must be configured together`.

Далі валідуються вхідні дані (порожній `subject`, відсутні і `text`, і `html`, порожній список отримувачів, порожній відправник) — це `badRequest`. Помилка SMTP логується (`Failed to send email`) і повертається як `internal`. Успіх логується як `Email sent` з `messageId`, `accepted`, `rejected`.

::: warning Наслідок для auth-флоу
Оскільки виклики нижче перетворюють помилку `send()` на `internal`, при вимкненому SMTP запити на верифікацію email і скидання пароля через email завершуються помилкою сервера, а не «тихо» успіхом. Для локальної розробки без SMTP цей шлях не працює — див. [Локальне тестування](#локальне-тестування).
:::

## Які листи надсилаються

Шаблонів-файлів і i18n немає: тема, `text` та `html` будуються в коді, англійською. Верстка в одному місці — `renderBrandedEmail` у [`email-templates.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/email-templates.ts) (палітра `EMAIL_BRAND`, екранування імені й посилання через `escapeHtml`); кожна з функцій нижче лише передає слова й тип дії (кнопка з запасним посиланням або одне посилання). Побайтово лист закріплено файлами в [`__snapshots__`](https://github.com/Blazheiko/vibe-template/tree/main/packages/backend/src/app/services/auth/__snapshots__).

| Лист                                       | Функція-шаблон           | Де викликається                                                                                                                                              |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Підтвердження email («Confirm your email») | `buildEmailContent`      | [`email-verification-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/email-verification-service.ts) |
| Прив'язка нового email до акаунта          | `buildLinkEmailContent`  | [`email-verification-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/email-verification-service.ts) |
| Скидання пароля                            | `buildResetEmailContent` | [`password-reset-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/password-reset-service.ts)         |

Посилання в листах містять сирий токен, а в БД зберігається лише його хеш. Деталі флоу — у [Автентифікації](/backend/auth#способи-входу).

## Тестовий лист: `mail:test`

Скрипт [`send-test-email.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/scripts/send-test-email.ts) (`tsx`, підвантажує `.env` через `dotenv/config`) надсилає простий лист через той самий `emailService`:

```bash
pnpm --filter backend mail:test you@example.com "Optional subject"
```

Без отримувача скрипт друкує usage і завершується з кодом `1`. При помилці друкує `Failed to send test email: <причина>` (наприклад `Email service is disabled`) і теж повертає `1`; при успіху — `Message ID` та прийнятих отримувачів. Див. також [Скрипти](/reference/scripts).

Юніт-тести сервісу — [`email-service.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/notifications/email-service.spec.ts).

## Локальне тестування

підніміть локальний SMTP-перехоплювач (наприклад Mailpit або MailHog на порту `1025`), задайте `SMTP_ENABLED=true`, `SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_REQUIRE_TLS=false`, `SMTP_FROM_EMAIL=noreply@example.com` без логіна/пароля і перевірте `pnpm --filter backend mail:test you@example.com`. Ці інструменти не входять до репозиторію.

Юніт-тести: `pnpm --filter backend test`.
