# Quick start

This page takes you from a clean clone to a running backend and frontend on your local machine. Every step has been verified on a clean clone of the repository.

## Prerequisites

| Tool       | Version                            | Source                                                                                                                                                             |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js    | `24.22.2` (requirement `^24.22.2`) | [.nvmrc](https://github.com/Blazheiko/vibe-template/blob/main/.nvmrc), [package.json](https://github.com/Blazheiko/vibe-template/blob/main/package.json)           |
| pnpm       | `>=9.0.0`, pinned to `pnpm@9.15.0` | [package.json](https://github.com/Blazheiko/vibe-template/blob/main/package.json) (`engines`, `packageManager`)                                                    |
| PostgreSQL | with the **pgvector** extension    | [create-database.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/db/create-database.ts) runs `CREATE EXTENSION IF NOT EXISTS vector` |
| Redis      | any modern version                 | [config/redis.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/redis.ts)                                                       |

The repository structure is described in [Project structure](/en/guide/project-structure).

You do not have to install PostgreSQL and Redis: with Docker, one command starts them (along with S3 and mail), see [Services via Docker Compose](#services-via-docker-compose) in step 2.

pgvector is needed for the Support AI knowledge base search, and the `vector` type is in the schema itself, so the extension is required even without AI. The plain `postgres` image does not include it, and `db:create` will fail on it. If you install PostgreSQL yourself, use the `pgvector/pgvector` image or install the extension: [Database → pgvector](/en/backend/database#pgvector).

## 1. Clone and install dependencies

```bash
git clone https://github.com/Blazheiko/vibe-template.git
cd vibe-template
nvm use          # takes the version from .nvmrc
make setup       # checks Node/pnpm/Docker, pnpm install, .env from .env.example, builds shared
```

`make setup` is the first step through the [Makefile](/en/reference/make), the single entry point for developer commands; `make` without arguments lists all targets.

::: tip Alternative: pnpm without make
`make` is optional. Every target only calls a pnpm script, so this entire guide can be followed with `pnpm`: `pnpm install` instead of `make setup`, `pnpm services:up` instead of `make services-up`, `pnpm --filter backend db:migrate` instead of `make db-migrate`, `pnpm dev` instead of `make dev`, `pnpm app:up` / `pnpm app:down` for the app in Docker. The mapping of all targets and scripts is in [make commands](/en/reference/make); `make -n <target>` prints the command without running it.
::: On Windows use WSL2: [make commands → Windows](/en/reference/make#windows).

## 2. The `.env` file for the backend

`make setup` has already created the file from `.env.example` (separately: `make env`; an existing `.env` is not overwritten). Without `make`:

```bash
cp packages/backend/.env.example packages/backend/.env
```

For local development, change these variables in `packages/backend/.env`:

```dotenv
APP_KEY=<random-string-at-least-32-chars>

PGSQL_HOST=127.0.0.1
PGSQL_PORT=5432
PGSQL_USER=postgres
PGSQL_PASSWORD=<your-pg-password>
PGSQL_DB_NAME=vibe_template

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=<your-redis-password>

# host and port the browser uses to connect to the WebSocket
DOMAIN=127.0.0.1:3000

# demo accounts for the first login (see step 3)
SEED_ADMIN_EMAIL=admin@example.com
SEED_ADMIN_PASSWORD=<admin-password-8-32-chars>
SEED_USER_EMAIL=user@example.com
SEED_USER_PASSWORD=<user-password-8-32-chars>

# the repository has no packages/backend/public directory
SERVE_STATIC=false
```

Notes:

- **The database** is read only from the `PGSQL_*` variables ([config/database.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/database.ts)); drizzle-kit takes the same values ([`drizzle.config.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/drizzle.config.ts)). Unset variables get the defaults `127.0.0.1:5432`, `postgres`, database `vibe_template`.
- **Redis**: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_PREFIX` ([config/redis.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/redis.ts)). If Redis runs without a password, leave `REDIS_PASSWORD` empty.
- **`SERVE_STATIC`**: `.env.example` sets it to `false`, because in dev Vite serves the frontend. `true` is needed only when `packages/backend/public` contains a built frontend; without that directory the server prints a warning and starts without static files.
- **`DOMAIN`** together with the port: the frontend connects to the WebSocket at `ws://<DOMAIN>/api/websocket`. Without a port the browser goes to port 80, login will work, but the header will show the **Disconnected** status and real-time features will not work.
- **`SEED_*`** are the logins and passwords of the demo accounts that `db:seed --demo` creates. The password must be 8 to 32 characters (as in the login form). These are local test values, do not use them anywhere else.
- **`APP_KEY`** is needed for OTP hashing when phone-auth is enabled (at least 32 characters, see [validate-runtime-config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/start/validate-runtime-config.ts)). With `AUTH_PHONE_ENABLED=false` the server starts without it, but it is better to set it right away.

The full list of variables with defaults is on the [Configuration](/en/backend/configuration) page.

### Services via Docker Compose

[docker-compose.yml](https://github.com/Blazheiko/vibe-template/blob/main/docker-compose.yml) in the root starts everything the backend talks to locally. The backend and frontend themselves run on the host via `pnpm dev`. How to run the app in containers too is described below: [The whole app in Docker Compose](#the-whole-app-in-docker-compose).

| Service  | Image                    | Port on `127.0.0.1`                          | Purpose                                                    |
| -------- | ------------------------ | -------------------------------------------- | ---------------------------------------------------------- |
| postgres | `pgvector/pgvector:pg16` | `PGSQL_PORT` (5432)                          | database with pgvector                                     |
| redis    | `redis:7-alpine`         | `REDIS_PORT` (6379)                          | sessions, WebSocket, throttling                            |
| s3       | `chrislusf/seaweedfs`    | `S3_HOST_PORT` (8333)                        | S3-compatible storage: avatars, knowledge base screenshots |
| mailpit  | `axllent/mailpit`        | `SMTP_PORT` (1025), `MAILPIT_UI_PORT` (8025) | catches all emails, web interface `http://localhost:8025`  |

```bash
make services-up     # pnpm services:up: docker compose --env-file packages/backend/.env up -d --wait
make services-down   # stop (and the app, if it is running), data stays in volumes
docker compose down -v   # stop and delete the data
```

Compose reads credentials and ports from `packages/backend/.env`, that is, from the same `PGSQL_*`, `REDIS_*` and `S3_*` that the backend uses, so both sides always match. Unset values take the defaults from `.env.example`: `postgres`/`postgres`, Redis without a password. If `REDIS_PASSWORD` is set, Redis starts with `requirepass`. `services:up` waits until all containers are `healthy`. Ports are opened only on `127.0.0.1`: these are development credentials, not meant for a shared network.

If a port is already taken (for example by a local PostgreSQL from Homebrew), `services-up` will fail with `bind: address already in use`. `make doctor` shows in advance which process holds the port. You can use a local PostgreSQL with pgvector instead of the container: `make services-up ARGS="redis s3 mailpit"` (`pnpm services:up redis s3 mailpit`). Details: [make commands → Busy ports](/en/reference/make#busy-ports-and-your-own-postgresql).

PostgreSQL and Redis work without extra variables. To enable file uploads and mail, add this to `.env`:

```dotenv
# S3 (SeaweedFS): the bucket is created on startup, the keys are whatever you choose
S3_ACCESS_KEY_ID=devaccesskey
S3_SECRET_ACCESS_KEY=devsecretkey
S3_BUCKET=vibe-template
S3_ENDPOINT=http://127.0.0.1:8333
S3_REGION=us-east-1
CDN_URL=http://127.0.0.1:8333/vibe-template

# mail goes to Mailpit
SMTP_ENABLED=true
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_REQUIRE_TLS=false
SMTP_IGNORE_TLS=true
SMTP_FROM_EMAIL=noreply@example.com
```

Anonymous read access in the storage is open only under `S3_BUCKET/S3_PREFIX/` (`app/` by default), because the browser loads avatars and screenshots directly from `CDN_URL`. The rest of the bucket and the object listing require a key. How the backend works with the storage: [File storage](/en/backend/storage).

::: tip Port already in use
If PostgreSQL or Redis is already running on the host, set different `PGSQL_PORT` / `REDIS_PORT` values in `.env` (for example `5433`): compose will expose the container on that port, and the backend will connect to it.
:::

::: warning Development only
This compose file is not meant for production: the default credentials are known to everyone, and SeaweedFS runs in the single-process `mini` mode. Deployment is described on the [Deployment](/en/backend/deployment) page.
:::

### The whole app in Docker Compose

To look at the app without Node.js on the host, or to check the production build itself, you can run it in compose together with the services. This is the same image as for production ([`Dockerfile`](https://github.com/Blazheiko/vibe-template/blob/main/Dockerfile)): the backend serves the built frontend (`SERVE_STATIC=true`), so everything works from a single origin `http://localhost:3000`. There is no hot reload here: after code changes the image has to be rebuilt. For daily development, `pnpm dev` remains the way to go.

```bash
make app-build   # scripts/docker-build.sh: local image vibe-template:local
make app-up      # services + migrate + app, waits until app is healthy
make app-seed    # optional: reference data and demo accounts from SEED_* in .env
make app-logs    # app log
make app-down    # stop only the app, services keep running (back to make dev)
make services-down   # stop everything
```

The app and migrations are described in compose under the `app` profile, so `make services-up` does not start them.

| Service   | What it does                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrate` | runs `pnpm db:create:prod && pnpm db:migrate` once and exits                                                                                 |
| `app`     | `node dist/index.js` on `127.0.0.1:APP_PORT` (3000); starts after `migrate` succeeds. `up --wait` waits for its `HEALTHCHECK` (`/api/ready`) |

[`scripts/docker-build.sh`](https://github.com/Blazheiko/vibe-template/blob/main/scripts/docker-build.sh) builds the image with the tag `APP_IMAGE` (`vibe-template:local` by default) and labels it with the git revision. The frontend is built without Sentry and without `VITE_BASE_URL`, that is, with the API on the same origin. Extra arguments are passed to `docker build`, for example `make app-build ARGS=--no-cache`. Compose neither builds nor pulls the image (`pull_policy: never`): without `make app-build`, `app:up` fails with the error `No such image: vibe-template:local`.

**Variables.** Containers receive the whole `packages/backend/.env` (`APP_KEY`, AI and OAuth keys, VAPID, limits), but compose overrides the values that must be different inside the compose network:

| What                     | Value in the container                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| app address              | `APP_URL`, `FRONTEND_URL`, `LANDING_URL` = `http://localhost:APP_PORT`, `DOMAIN=localhost:APP_PORT`                                   |
| mode                     | `APP_ENV=local`, `APP_IS_PRODUCTION=false`, `SERVE_STATIC=true`, `DOC_PAGE=false`                                                     |
| PostgreSQL, Redis        | `PGSQL_HOST=postgres`, `PGSQL_PORT=5432`, `REDIS_HOST=redis`, `REDIS_PORT=6379`                                                       |
| S3                       | `S3_ENDPOINT=http://s3:8333`, keys and bucket are the same as for the `s3` service; `CDN_URL=http://localhost:S3_HOST_PORT/S3_BUCKET` |
| mail                     | Mailpit: `SMTP_ENABLED=true`, `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, no TLS                                                           |
| origins for CSRF and CSP | `CSRF_ALLOWED_ORIGINS`, `CSP_API_ORIGIN`, `CSP_WS_ORIGIN` are empty, so they are taken from `APP_URL` and `DOMAIN`                    |

`APP_ENV=local` is needed for the same reason as in `pnpm prod:local`: it is plain http. With `production`, the session cookie would have the `Secure` flag, the WebSocket would get `wss://`, and CSP would add `upgrade-insecure-requests`. Everything else, including `CSRF_ENFORCE` and `CSRF_STRICT_ORIGIN`, is taken from your `.env` unchanged.

::: tip Port 3000 already in use
`make dev` also listens on port 3000. To go back to development, run `make app-down`: it removes the `app` and `migrate` containers and leaves the services. To run both at the same time, stop `make dev` or set a different `APP_PORT` in `.env`, for example `APP_PORT=3001`: then the app will be at `http://localhost:3001`, and all addresses in the table above will adjust to that port.
:::

Verified (2026-11-06, Docker Desktop on macOS):

- after `make app-up` all containers are `healthy`, `migrate` exited with code 0;
- `/api/ready` returns `ok`, `/` serves the SPA with a CSP that contains the app origin and `CDN_URL`;
- demo user login through CSRF; with `CSRF_ENFORCE=true` a foreign origin gets `403 origin_mismatch`;
- an avatar is uploaded to SeaweedFS and read by the browser from `CDN_URL`;
- a password reset email with a link to `http://localhost:<APP_PORT>` shows up in Mailpit;
- the WebSocket at `ws://localhost:<APP_PORT>/api/websocket` opens;
- `make services-up` starts only the four services, `make services-down` also stops the app.

### What you need now and what you can configure later

For the first run you only need PostgreSQL (with pgvector) and Redis. All integrations in `.env.example` are disabled or empty, and the server starts with them. Behavior without each service was verified on a clean `.env` from `.env.example`.

| Service                          | For startup  | Variables                                          | What happens without it                                                                                                                                                       | Details                                                       |
| -------------------------------- | ------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| PostgreSQL + pgvector            | **required** | `PGSQL_*`                                          | The server does not work. Without pgvector, `db:create` already fails: the `vector` type is in the schema even if you do not need AI                                          | [Database](/en/backend/database#pgvector)                     |
| Redis                            | **required** | `REDIS_*`                                          | No sessions: login is impossible                                                                                                                                              | [Authentication](/en/backend/auth)                            |
| SMTP                             | no           | `SMTP_ENABLED`, `SMTP_*`                           | Emails are not sent. `forgot-password` responds `200`, but no email goes out, and the log says `Email service is not configured`. Demo accounts already have a verified email | [Mail](/en/backend/mail)                                      |
| S3 / MinIO                       | no           | `S3_*`, `CDN_URL`                                  | Avatar upload returns `500 Failed to upload avatar`; knowledge base article screenshots are not saved                                                                         | [File storage](/en/backend/storage)                           |
| AI provider                      | no           | `AI_TEXT_DRIVER`, `OPENAI_*`, `XAI_*`, `MISTRAL_*` | The support chat shows `Failed to open support chat`, the log says `OpenAI is not configured`. Knowledge base embeddings require `OPENAI_API_KEY` specifically                | [AI](/en/backend/ai)                                          |
| VAPID keys (Web Push)            | no           | `VAPID_*`                                          | `GET /api/push-subscriptions/vapid-public-key` → `500 VAPID keys not configured`, push subscription is impossible                                                             | [Web Push](/en/backend/web-push-notification#generating-keys) |
| SMS provider                     | no           | `AUTH_PHONE_ENABLED`, `AUTH_SMS_*`                 | Phone login and registration are disabled: `400 Phone authentication is disabled`                                                                                             | [Authentication](/en/backend/auth#sign-in-methods)            |
| OAuth (Google, GitHub, Facebook) | no           | `GOOGLE_*`, `GITHUB_*`, `FACEBOOK_*`               | Social login buttons lead to the provider page with an empty `client_id`, and the provider shows an error                                                                     | [Authentication](/en/backend/auth#sign-in-methods)            |
| Sentry                           | no           | `SENTRY_*`                                         | Errors only appear in the logs                                                                                                                                                | [Observability](/en/backend/observability)                    |

Connect integrations when your scenario gets to them: the variables are described on the [Configuration](/en/backend/configuration) page.

## 3. Database

Commands are run from the root; each one calls a script of the backend workspace (`pnpm --filter backend db:*`):

```bash
make db-create    # creates the DB and the vector extension
make db-migrate   # drizzle-kit migrate
make db-seed      # initial prompts; with ARGS=--demo also demo accounts
```

Expected output:

```text
Database "vibe_template" created successfully.
Extension "vector" ensured in database "vibe_template".
...
[✓] migrations applied successfully!
```

`db:create` can be run repeatedly: for an existing DB it prints `Database "vibe_template" already exists.`

::: info Seed
`db:seed` inserts the initial AI prompts and is safe to re-run. To get an admin for local work, set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in `.env` (optionally `SEED_USER_*`) and run `make db-seed ARGS=--demo`. Run the seed before `make dev`, because prompts are cached at startup. Details: [Database → Seed](/en/backend/database#seed).
:::

More about the schema and migrations: [Database](/en/backend/database).

## 4. Run

```bash
make dev
```

The target calls `pnpm dev`: the script builds `shared` and `backend`, and then runs the backend and frontend dev servers in parallel ([package.json](https://github.com/Blazheiko/vibe-template/blob/main/package.json)). After startup:

| Service                    | URL                                                                       | Source                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Backend (HTTP + WebSocket) | `http://localhost:3000` (`PORT`, `HOST=0.0.0.0`)                          | [config/app.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/config/app.ts) |
| Frontend (Vite)            | `http://localhost:5173`; `/api` and `/ws` are proxied to `127.0.0.1:3000` | [vite.config.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/vite.config.ts)  |

The backend log should show the line `Listening http://0.0.0.0:3000`, and Vite should show `Local: http://localhost:5173/`.

Packages can also be started separately: `make dev-backend` / `make dev-frontend` (see [make commands](/en/reference/make)).

## 5. Health check

The `GET /ping` route is declared in [http-routes.ts](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/routes/http-routes.ts). HTTP routes have the prefix `API_PATH_PREFIX`, `api` by default:

```bash
curl -i http://127.0.0.1:3000/api/ping
```

```text
HTTP/1.1 200 OK
content-type: application/json
...
{"status":"ok"}
```

Through the Vite proxy, the same request works at `http://localhost:5173/api/ping`.

## 6. First scenario: from login to logout

`/api/ping` shows that the server is alive. Now go through the path of a regular user to see what the template can already do. You need the demo accounts from step 3 (`db:seed --demo`).

### Sign in

Open `http://localhost:5173`, click **Sign In** and enter `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from your `.env`.

![Login form](/screenshots/login.jpg)

**Expected result:** the account page opens, and the header on the right shows a green **Connected** status. This means the WebSocket connection has been opened.

![Account page after login](/screenshots/account.jpg)

The account page already supports changing the password, linking a phone and email, the theme and the font size. The avatar uploads if S3 is configured (see the table above).

### Look at the requests in DevTools

Open DevTools → **Network** and refresh the page.

| What to find                | What you will see there                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`      | Request body with email and password. The response has `{"status":"success","user":{...},"wsUrl":...,"wsToken":...,"csrfToken":...}` and the [header](/en/reference/glossary#header) `Set-Cookie: uapi=...; HttpOnly; SameSite=Lax` |
| `GET /api/main/init`        | A request on every app load. The browser sends the `uapi` cookie by itself. The response is the user data, `wsUrl`, `wsToken`, a new `csrfToken`                                                                                    |
| `websocket` (filter **WS**) | A connection `ws://127.0.0.1:3000/api/websocket` with status `101`. The **Messages** tab shows the messages the client and server exchange                                                                                          |
| any `POST` after login      | The `x-csrf-token` header: the frontend adds it by itself                                                                                                                                                                           |

The `GET /api/main/init` response for a logged-in user (tokens shortened):

```json
{
    "status": "ok",
    "csrfToken": "<…>",
    "user": {
        "id": "1",
        "name": "Admin",
        "email": "admin@example.com",
        "phone": null,
        "emailVerified": true,
        "emailVerifiedAt": "2026-10-25T15:05:42.229Z",
        "avatar": null,
        "role": "admin",
        "createdAt": "2026-10-25T17:05:42.143Z",
        "updatedAt": "2026-10-25T17:05:42.143Z"
    },
    "wsUrl": "ws://127.0.0.1:3000/api/websocket",
    "wsToken": "<…>",
    "storage": {
        "cdnUrl": "",
        "s3Prefix": "app",
        "s3StaticDataPrefix": "public",
        "s3DynamicDataPrefix": "uploads"
    }
}
```

What happens here is explained on the [How the backend works](/en/guide/how-backend-works#how-sessions-work) page.

### Open the admin panel

The demo admin has the `admin` role, so the admin panel is available to them: open `http://localhost:5173/admin/user-online`.

**Expected result:** you are in the **User Online** list. Open the app in another browser (or an incognito window) and sign in as `SEED_USER_EMAIL`: **Demo User** appears in the list without a page refresh, because the admin panel receives the event through the WebSocket.

![Online users in the admin panel](/screenshots/admin-online.jpg)

### Sign out

Click the menu (☰) on the right in the header → **Logout**.

**Expected result:** the login form opens. The `GET /api/main/init` request now returns `401`:

```json
{
    "status": "error",
    "code": "unauthorized",
    "message": "Session expired or not found",
    "csrfToken": "<…>"
}
```

The session has been deleted from Redis, so the old [cookie](/en/reference/glossary#cookie) no longer opens anything.

### The same with curl

This scenario can be run without a browser. Cookies are stored in the `cookies.txt` file, and the CSRF token is taken from the `init` response. The token is needed even for login: `init` first creates a guest session, and the login request must come with its token. The browser adds the `Origin` header to a `POST` by itself, but curl does not, so it has to be passed explicitly: without it the server responds `403` ([why](/en/guide/csrf)).

```bash
B=http://127.0.0.1:3000/api
# Frontend origin: in dev the server trusts the origin from APP_URL and FRONTEND_URL
O='origin: http://localhost:5173'

# 0. guest session and CSRF token: the server rejects a POST without a token
CSRF=$(curl -s -c cookies.txt -b cookies.txt $B/main/init | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')

# 1. login: the server sets the session cookie
curl -s -c cookies.txt -b cookies.txt -H "$O" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"identifier":"user@example.com","password":"<user-password>","token":""}' $B/auth/login

# 2. who am I: the cookie is sent automatically
curl -s -b cookies.txt $B/main/init

# 3. logout: after login the token is new, take it again from init
CSRF=$(curl -s -b cookies.txt -c cookies.txt $B/main/init | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
curl -s -b cookies.txt -c cookies.txt -X POST -H "$O" -H "x-csrf-token: $CSRF" $B/auth/logout

# 4. after logout: 401
curl -s -o /dev/null -w '%{http_code}\n' -b cookies.txt $B/main/init
```

The login body is described by the schema [`login.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/auth/login.ts): `identifier` is an email or a phone, `token` is optional (the frontend passes an empty string). The schema rejects unknown fields: with the old `email` field instead of `identifier` the server responds `422 validation_failed`.

## Troubleshooting

| Symptom                                                                                                                   | Cause and solution                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENOENT ... scandir '.../packages/backend/public'` during startup                                                         | `SERVE_STATIC=true` is enabled. Set `SERVE_STATIC=false` or create the `packages/backend/public` directory.                                           |
| `db:create` fails on `CREATE EXTENSION ... vector`                                                                        | PostgreSQL has no pgvector. Use the `pgvector/pgvector` image or install the extension.                                                               |
| `ECONNREFUSED` / authentication error during `db:*`                                                                       | Check `PGSQL_HOST`, `PGSQL_PORT`, `PGSQL_USER`, `PGSQL_PASSWORD`.                                                                                     |
| Redis errors (`NOAUTH`, `ECONNREFUSED`)                                                                                   | `REDIS_PASSWORD` and `REDIS_PORT` must match the Redis server settings.                                                                               |
| `bind: address already in use` for 5432/6379/3000/5173                                                                    | The port is already taken. Free it or change the port (`-p <host-port>:5432` in Docker plus the matching variable in `.env`, `PORT` for the backend). |
| The server prints `start success`, but `curl /api/ping` gives `connection refused`, the log says `Listening unix socket:` | `APP_UNIX_PATH=` is empty, and your code version does not include the fix yet. Remove the `APP_UNIX_PATH` line from `.env`.                           |
| After login the header shows **Disconnected**, the console shows `WebSocket error`, `1006`                                | `DOMAIN` without a port. Set `DOMAIN=127.0.0.1:3000` and restart the backend.                                                                         |
| `pnpm install` complains about engines                                                                                    | Switch to the Node from `.nvmrc` (`nvm use`) and pnpm `>=9`.                                                                                          |
| Phone-auth does not start because of the OTP secret                                                                       | Set `APP_KEY` or `AUTH_OTP_HMAC_KEY` with a length of at least 32 characters.                                                                         |

::: tip Next step
[How the backend works](/en/guide/how-backend-works): what happened with each request you just saw in DevTools.
:::
