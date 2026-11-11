# Backend overview

::: tip First time here?
This page is a technical overview. If you are just getting to know the template, start with [How the backend works](/en/guide/how-backend-works): it explains in plain words the path of a request and why the layers are needed.
:::

The `backend` package ([packages/backend](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend)) is an HTTP and WebSocket server in TypeScript (ES modules), built on uWebSockets.js. The entry point is [src/index.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/index.ts); in development it is run via `tsx watch`, in production as `node dist/index.js` (see [Scripts](/en/reference/scripts)).

## Stack

Based on the dependencies in [packages/backend/package.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/package.json):

| Purpose               | Dependencies                                                  |
| --------------------- | ------------------------------------------------------------- |
| HTTP/WebSocket server | `uWebSockets.js` (`v20.71.0` from GitHub), `ws`               |
| DB                    | `drizzle-orm` / `drizzle-kit` `1.0.0-rc.5`, `pg` (PostgreSQL) |
| Validation            | `@arktype/type`                                               |
| Redis                 | `ioredis`                                                     |
| Monitoring and logs   | `@sentry/node`, `pino`, `pino-pretty`                         |
| File storage          | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`         |
| Mail                  | `nodemailer`                                                  |
| Push notifications    | `web-push`                                                    |
| AI                    | `ai`, `@ai-sdk/xai`, `openai`, `@mistralai/mistralai`         |
| OAuth                 | `arctic`                                                      |
| Utilities             | `better-result`, `dotenv`, `luxon`, `metautil`, `nanoid`      |
| Contracts             | `shared` (`workspace:*`)                                      |

Tests use Vitest, the build is `tsc --build` with a reference to `../shared` ([tsconfig.json](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/tsconfig.json)).

## `src` structure

| Directory                                                                                              | Contents                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [app](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app)                   | Application logic: `controllers` (http, ws), `middlewares`, `repositories`, `transformers`, `services`, `routes` (`http-routes.ts`, `ws-routes.ts`), `routing` (`contract-registry.ts`, `define-ws-route.ts`, `define-raw-route.ts` for tests), `routes/contract-schemas` (the contract schema registry), `start`, `state`, `validate`, `websocket` |
| [config](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config)             | Configuration modules: `app`, `auth`, `cookies`, `cors`, `csp`, `csrf`, `database`, `redis`, `session`, `mail`, `disk`, `push`, `ai`, `oauth`, `sentry`, etc.                                                                                                                                                                                       |
| [vendor](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor)             | Infrastructure core: `start/` (`server.ts`, `router.ts`, `static-server.ts`), `utils/` (logger, session, rate-limit, storage, validation…), `contracts/`, `types/`                                                                                                                                                                                  |
| [database](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/database)         | Connections (`db.ts`, `redis.ts`), schema (`schema.ts`) and relations (`relations.ts`)                                                                                                                                                                                                                                                              |
| [db](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/db)                     | The `create-database.ts` and `seed.ts` scripts                                                                                                                                                                                                                                                                                                      |
| [drizzle](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/drizzle)           | Migrations (`migrations/`, one folder per migration)                                                                                                                                                                                                                                                                                                |
| [openapi](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/openapi)           | Unused OpenAPI stubs (`spec.ts` is empty)                                                                                                                                                                                                                                                                                                           |
| [test-support](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/test-support) | Test helpers: temporary PostgreSQL database, test Redis, image fixtures                                                                                                                                                                                                                                                                             |
| [scripts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/scripts)           | Utility scripts, including `send-test-email.ts`                                                                                                                                                                                                                                                                                                     |

### Directory tree

Tests (`*.spec.ts`, `*.test.ts`) live next to the code and are not shown in the tree.

```text
packages/backend/src/
├── index.ts                  # entry point: server start, graceful shutdown
├── sentry-bootstrap.ts       # Sentry initialization before the rest of the imports
├── app/                      # application logic (your code)
│   ├── routes/               # route tables
│   │   ├── http-routes.ts    #   HTTP: method, path, middleware, schemas, controller
│   │   └── ws-routes.ts      #   WebSocket events
│   ├── routing/              # contract-registry.ts, define-ws-route.ts — route declaration helpers; define-raw-route.ts — tests only
│   ├── middlewares/          # kernel.ts (registry), csrf-guard, admin-guard, ws-admin-guard
│   ├── controllers/          # thin layer: gets data from the request, calls a service, returns a response
│   │   ├── http/             #   admin, ai, auth, core, notifications, support, user
│   │   ├── ws/               #   admin-ws-controller, support-controller
│   │   └── shared/           #   controller-error.ts
│   ├── services/             # business logic, one folder per domain
│   │   ├── auth/             #   login, OAuth, email confirmation, password reset, throttle
│   │   ├── user/             #   avatar, roles
│   │   ├── admin/            #   users and online status for the admin panel
│   │   ├── ai/               #   providers (adapters/: OpenAI, xAI, Mistral), prompts, token accounting
│   │   ├── support/          #   AI support chat and knowledge base (pgvector)
│   │   ├── notifications/    #   mail, Web Push, subscriptions
│   │   ├── communication/    #   broadcast, who is online, WS presence
│   │   ├── core/             #   main-service (init), readiness for /ready
│   │   ├── statistics/       #   push subscription statistics
│   │   ├── observability/    #   sentry-service
│   │   ├── actions/          #   ToolDefinition — description of tools for AI
│   │   └── shared/           #   errors, result helpers, session access
│   ├── repositories/         # the only layer that talks to the DB (Drizzle)
│   │   ├── auth/  user/  ai/  support/  notifications/  communication/  health/
│   │   └── index.ts
│   ├── transformers/         # DB row → response object (user, push-subscription)
│   ├── validate/             # request validation
│   │   ├── adapters/         #   arktype-adapter
│   │   ├── checkers/         #   cookie, header, parameter
│   │   ├── schemas/          #   common/, query/
│   │   └── errors/           #   validation-error.ts
│   ├── websocket/            # connection registry, coordinator, WS session authorization
│   ├── state/                # state.ts — shared process state (listenSocket)
│   └── start/                # index.ts, validate-runtime-config.ts — config check at startup
├── config/                   # one module per subsystem: app, auth, cors, csp, csrf, database,
│                             #   redis, session, mail, disk, push, ai, oauth, sentry, rate-limit…
├── vendor/                   # the template's infrastructure core, usually not changed
│   ├── start/                #   server.ts, router.ts, static-server.ts, validators.ts
│   ├── utils/                #   context, env, helpers, middlewares, network, rate-limit,
│   │                         #   routing, session, storage (S3), tooling, validation, logger.ts
│   ├── contracts/            #   validator.ts — validator interface
│   ├── constants/            #   shared constants, mime-types
│   └── types/                #   types.d.ts
├── database/                 # db.ts, redis.ts, schema.ts (tables), relations.ts
├── drizzle/
│   └── migrations/           # generated by drizzle-kit, one folder per migration
├── db/                       # create-database.ts, seed.ts, seed/
├── scripts/                  # utility scripts (send-test-email.ts)
├── test-support/             # temporary DB, test Redis, fixtures
└── openapi/                  # unused stubs
```

A new domain is added the same way every time: a file in `repositories/<domain>/`, `transformers/` if needed, a service in `services/<domain>/`, a controller in `controllers/http/<domain>/` and a line in `routes/http-routes.ts`. Step by step: [Adding a feature](/en/backend/adding-a-feature).

Modules are imported through the aliases `#app/*`, `#config/*`, `#vendor/*`, `#database/*`, `#drizzle/*` and `#logger`; see [Project structure](/en/guide/project-structure).

Business logic is laid out in the layers `repository → transformer → service → controller → route`, and request/response contracts are described in `shared` ([README.md](https://github.com/Blazheiko/vibe-template/blob/main/README.md)).

## Where to next

- [Architecture](/en/backend/architecture)
- [Request lifecycle](/en/backend/request-lifecycle)
- [Configuration](/en/backend/configuration)
- [Routing](/en/backend/routing)
- [Middleware](/en/backend/middlewares)
- [Database](/en/backend/database)
- [Authentication](/en/backend/auth)
- [Social login](/en/backend/oauth)
- [Security](/en/backend/security)
- [Adding a feature](/en/backend/adding-a-feature)
