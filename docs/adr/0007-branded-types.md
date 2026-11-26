# ADR 0007: брендовані типи для id, секретів і одиниць

- **Статус:** прийнято 2026-11-25; реалізація — feat-262 (спільний валідатор id і `shared/brand`), feat-263 і далі.
- **Дата запису:** 2026-11-25.
- **Джерело:** план [`docs/plan/branded-types-plan.md`](../plan/branded-types-plan.md) (редакція 5, рішення Р1–Р13), task
  list [`docs/plan/branded-types-tasks.md`](../plan/branded-types-tasks.md).

## Контекст

Id рядків БД — це `bigint` у бекенді й рядок на дроті. У `app/` було 203 параметри `…Id: bigint` і 186 `…Id: string`,
близько 32 сигнатур із двома id одного примітивного типу, і порядок аргументів між шарами був різний: сервіс приймав
`(userId, subscriptionId)`, а викликав репозиторій з `(id, userId)`. Переставлені аргументи компілювалися. Так само
`string` були і сирий токен, і його хеш, а `number` — мілісекунди й секунди.

## Рішення

1. **Бренд, а не клас (Р1).** Value object — це брендований примітив плюс модуль-конструктор (`parse…` → `T | null`,
   `as…` для довірених джерел). Значення лишаються `bigint` / `string` / `number`: вони без перетворень ходять через
   JSON, Redis і Drizzle, а поведінку несуть функції модуля.
2. **Один тип `Brand` (Р2).** `Brand<T, Id>` у [`shared/brand`](../../packages/shared/src/brand/index.ts) має форму
   `.brand()` ArkType; [`brands/type-checks.ts`](../../packages/shared/src/brands/type-checks.ts) перевіряє двосторонню
   рівність під час збірки. `shared/brand` не імпортує бібліотек, тож браузер може брати його як значення.
3. **Бренд id для кожної сутності, лише на бекенді (Р3).** `UserId = Brand<bigint, 'UserId'>` тощо оголошено в
   [`database/ids.ts`](../../packages/backend/src/database/ids.ts) і поставлено на колонки через Drizzle
   `.$type<…>()`, тож рядки з репозиторіїв брендовані самі. `$type` додається в тій самій фічі, що й сигнатури домену:
   брендована колонка не приймає `bigint` в `eq()` і `.values()`. На дроті id лишається рядком (`EntityId`).
4. **Конструктор для кожного бренду (Р4).** `parseUserId(raw): UserId | null`, `parseOAuthAccountId` тощо в
   [`app/domain/ids.ts`](../../packages/backend/src/app/domain/ids.ts); публічного `parseId<B>` немає, бо він дозволяв
   би викликачеві обрати бренд, тобто був би тим самим приведенням. Перевірку робить `isValidEntityId` (feat-262).
   `toEntityId` перетворює id на рядок у трансформерах.
5. **Зовнішнє значення стає брендом лише через схему або конструктор (Р10).** Приведення до бренду (`as UserId`,
   `<UserId>x`, `as unknown as UserId`) дозволене лише в модулях-конструкторах: `shared/src/brand/**`,
   `database/ids.ts`, `app/domain/**` і тестах. Модулі `app/domain/**` не мають `#`-імпортів, бо `database/schema.ts`
   імпортує їх відносно, а drizzle-kit виконує схему без аліасів.
6. **Порядок аргументів (Р11): спершу scope (власник), потім ключ рядка, потім дані** — `findForUser(userId, id)`,
   `updateByEndpoint(userId, endpoint, data)`. Два id одного бренду (адміністратор і цільовий користувач) передаються
   лише об'єктом-параметром.
7. **Бренд лише на межі app (Р13).** Vendor-типи сесії (`SessionData`, `SessionInfo`) лишаються з `userId: string`;
   `UserId` з'являється через `parseUserId` там, де app читає id із сесії, а запис у сесію йде через `toEntityId`.
   Сесія з невалідним `userId` вважається без користувача.

## Розглянуті альтернативи

- **Класи value objects.** Відхилено: `bigint` і рядки мали б загортатися й розгортатися на кожній межі (JSON, Redis,
  Drizzle), а поведінки, яка потребувала б класу, немає.
- **Один бренд `EntityId` для всіх id на бекенді.** Відхилено: він ловить лише формат, а переставлені id різних
  сутностей лишаються взаємозамінними.
- **Generic `parseId<B>`.** Відхилено: викликач сам обирає бренд, і це той самий неперевірений cast.
- **Бренд у vendor-типах сесії.** Відхилено: vendor-ядро не знає app-брендів, а JSON із Redis отримав би бренд через
  `as` без перевірки.

## Наслідки

- Переставлені id різних сутностей не компілюються; тести типів (`@ts-expect-error`) фіксують це для кожної пари.
- Нова сутність отримує бренд id у `database/ids.ts`, `$type` у схемі й конструктор у `app/domain/ids.ts`
  (`documentation/backend/adding-a-feature.md`, скіл `backend-feature`).
- `$type` змінює лише типи: `db:generate` не створює міграції.
- Приведення до бренду поза конструкторами ловить ESLint-правило `no-brand-cast` (feat-263).
- Відповіді й broadcast-події несуть `EntityId`, `IsoDateTime`, `Cursor` і `SessionPublicId` (feat-268): бекенд
  брендує значення через `toEntityId`, `toIsoDateTime` і конструктори `app/domain/wire.ts`, фронтенд отримує типи з
  `shared/responses`, а правило `no-brand-cast` діє й у `packages/frontend`. Брендоване поле query надсилається
  рядком (`QueryWireValue` знімає бренд). На фронтенді id різних сутностей лишаються одним `EntityId`.
