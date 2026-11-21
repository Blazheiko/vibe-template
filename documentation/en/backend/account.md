# Account, profile and sessions

The signed-in user changes their name, interface language and time zone, and their theme, color and font size are kept on the server, so they are the same on every device; an open tab or device gets a change without a reload (feat-232). Two routes do it: `GET /api/account/profile` and `PATCH /api/account/profile`. `GET /api/main/init` carries the same preferences, so the app applies them right after it starts.

Sources: the contract [`contracts/account.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/account.ts), the body [`schemas/account/update-profile.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/account/update-profile.ts) and the name rule [`profile-name.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/account/profile-name.ts), the answer [`responses/account-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/account-controller.ts), the zone rule [`utils/time-zone.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/utils/time-zone.ts); in the backend [`account-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/user/account-controller.ts), [`account-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-service.ts), [`user-preferences-repository.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/user/user-preferences-repository.ts) and [`profile-transformer.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/profile-transformer.ts).

## Routes

| Route                        | Middleware                                | What it does                                                                |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/account/profile`   | `session_web`, `csrf_guard`, `auth_guard` | the profile of the signed-in user                                           |
| `PATCH /api/account/profile` | `session_web`, `csrf_guard`, `auth_guard` | changes the passed fields and answers the profile as it is after the change |
| `GET /api/account/access`    | `session_web`, `csrf_guard`, `auth_guard` | the role of the signed-in user ([below](#role-of-the-current-user))         |

Both profile routes answer `{ "status": "success", "profile": Profile }`:

```json
{
    "status": "success",
    "profile": {
        "name": "Ann",
        "preferences": {
            "locale": "uk",
            "timeZone": "Europe/Kiev",
            "theme": null,
            "colorTheme": "mint",
            "fontSize": null
        },
        "revision": "3"
    }
}
```

The same `preferences` and `revision` are in `user` of `GET /api/main/init`.

## Role of the current user

`GET /api/account/access` answers `{ "status": "success", "role": Role }` (feat-240); the role is read from `users.role` on every request, a deleted user gets `404`. A tab ([`useAccessSync.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/composables/useAccessSync.ts)) reads it again on every `ws_ready` and when the tab is shown again; the answer is applied only when no `access_changed` came and the account did not change since. Roles and permissions: [Roles and capabilities](/en/reference/roles-capabilities).

## Body of PATCH: absent, `null` and a value

The body is partial: `{ name?, locale?, timeZone?, theme?, colorTheme?, fontSize? }`, at least one field, no other keys (`422 validation_failed` otherwise).

- **An absent field is not changed.**
- **`null` resets a preference**: the user has no choice, and the client shows the default. `name` cannot be `null`.
- **A value** is the user's explicit choice.

| Field        | Allowed values                                                                                                                                                                                                                                            | Default shown for `null`                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `name`       | trimmed and NFC-normalized, then 1–100 characters (code points, as `varchar(100)` counts), without control characters (`\p{Cc}`, line breaks included) and the Unicode line/paragraph separators. Markup is a valid name: it is escaped where it is shown | —                                         |
| `locale`     | one of `SHIPPED_LOCALE_CODES` (`en`, `uk`, `pl`)                                                                                                                                                                                                          | the browser language, then `en`           |
| `timeZone`   | `UTC` or an IANA zone the server runtime knows (`isAllowedTimeZone`), at most 64 characters                                                                                                                                                               | the browser zone                          |
| `theme`      | `light`, `dark`                                                                                                                                                                                                                                           | the system theme (`prefers-color-scheme`) |
| `colorTheme` | `COLOR_THEMES` of `shared/enums` (`ocean`, `mint`, `lavender`, `rose`, `sunset`, `monochrome`)                                                                                                                                                            | `DEFAULT_COLOR_THEME` (`rose`)            |
| `fontSize`   | an integer 14–20                                                                                                                                                                                                                                          | `DEFAULT_FONT_SIZE` (16)                  |

**The time zone** has one rule for writing and reading, `isAllowedTimeZone` in `shared`: `UTC` (not in `Intl.supportedValuesOf('timeZone')` of Node 24, so it is added explicitly), a zone from that list, or a name `Intl.DateTimeFormat` resolves to one of them (ICU lists `Europe/Kiev`, a browser may report `Europe/Kyiv`). An unknown zone answers `400` with `reason: "unknown_time_zone"`, before the limit is spent and with nothing written. The list depends on the ICU of the runtime: a stored zone a newer Node no longer knows reads as `null`, not as an error. The same goes for a stored language the interface no longer ships.

## Storage and `revision`

The name stays in `users.name`. The preferences are in the `user_preferences` table, one row per user ([Database](/en/backend/database#migrations)); a user may have no row, and then every preference is `null`.

`revision` counts the changes of the profile:

- no `user_preferences` row: `"0"`;
- the first successful `PATCH` inserts the row with **1**, each later one adds 1 in the same statement (`INSERT … ON CONFLICT (user_id) DO UPDATE SET <passed fields>, revision = user_preferences.revision + 1 … RETURNING`), also when only the name changed: the row is then created or updated for the revision alone;
- `GET /account/profile` and `init` read the name and the preferences in **one statement** (`users LEFT JOIN user_preferences`), so the name and the revision always come from one committed state; two reads, even in one transaction at `READ COMMITTED`, could see a `PATCH` commit between them;
- in JSON it is a **decimal string**, like the ids; clients compare it as a number (`BigInt`), never as a string (`"10"` is after `"9"`).

Concurrent changes of different fields both stay (the upsert writes only the passed fields); of the same field, the commit that comes later wins, and each adds one to the revision: the row lock orders them. The client drops a snapshot whose revision is lower than the one it shows.

The name and the preferences are one transaction (`withTransaction`), every repository call in it gets the same `tx`: a failure writing `user_preferences` rolls the name back. The transaction calls nothing outside the database.

## Revoked session

A change is written only while the session is current, as with a password change: the token the request presented must still be `users.session_token` (a logout everywhere or a claim rotates it), and the session record must still be stored (a logout in another tab deletes it). The check of the token is part of the write: the name is updated `WHERE session_token = <presented>`, or, without a name, the user row is read `FOR SHARE` with the same condition, so a revocation that comes after waits for the change to commit. A revoked session gets the same answer as a password change, `403 csrf_invalid` once its record is gone or `401`, and nothing is written.

## Rate limit

`accountProfileUser` ([Security → Shared limits](/en/backend/security#shared-limits-redis)): 30 changes per user in a fixed 10-minute window, one budget for all their sessions, `AUTH_PROFILE_MAX_UPDATES_PER_USER_PER_10_MIN` ([Configuration](/en/backend/configuration#shared-auth-limits-redis)). The 31st change answers `429 rate_limited`. It is consumed before the write; when Redis does not answer, the change fails closed (`503`), like the other auth limits. The account page saves preferences as they change, so the budget allows a burst; the font size slider sends only its last value.

## In the frontend

The account page has a profile form (name, language with "Same as the browser", time zone with a search, `UTC` and "Same as the browser") and the settings panel (theme: "Same as the system", light or dark; color and font size with "Default"). The settings save through one queue per tab; how it keeps the newer choice and what happens when the account changes is in [Frontend → Preferences](/en/frontend/#preferences-language-and-time-zone).

## Live sync

After the commit, `PATCH` sends `broadcast:user_profile_updated` with the new `Profile` to every connection of the user on every instance, the tab that made the change and other tabs of the same session included ([WebSocket → Events to a user on every instance](/en/backend/websocket#events-to-a-user-on-every-instance)). The answer does not wait for it, and a failed event does not fail the change. The client applies it like any snapshot, by `revision`, under its unsaved changes, so an event that arrives late or twice changes nothing. Events are not replayed: on `service:connection_ready` of every WS connection, the first one included, the client reads `GET /account/profile`. The server sends that signal only once the socket is registered, so a change committed before the read is in it and one committed after reaches the socket as an event; the browser's `open` comes earlier, while the server may still check the session.

## Verification

```bash
B=http://127.0.0.1:3000/api
O='origin: http://localhost:5173'
# after signing in as in "How to add a feature to the backend", with $CSRF of the session
curl -s -b cookies.txt $B/account/profile
curl -s -b cookies.txt -X PATCH -H "$O" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"theme":"dark","fontSize":18}' $B/account/profile
curl -s -b cookies.txt -X PATCH -H "$O" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" \
  -d '{"theme":null}' $B/account/profile
```

Tests: [`account-service.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-service.spec.ts), [`account-preferences.pg.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-preferences.pg.test.ts) (upsert, `CHECK`, concurrent changes), [`account-service.pg.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-service.pg.test.ts) (rollback of the name), [`account-http.pg.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-http.pg.test.ts) (the routes over HTTP, revoked sessions), [`account-throttle.redis.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-throttle.redis.test.ts); in the frontend [`useProfileSave.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/composables/__tests__/useProfileSave.spec.ts) and [`e2e-live/account-profile.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/e2e-live/account-profile.spec.ts).

Ending all other sessions writes `auth.sessions.revoked_others` to the [audit log](/en/backend/audit-log).

## Active sessions

The account page lists every active sign-in of the user: browser, operating system, IP address, how and when they signed in, when the session was last active, which one is this device and which are online. The user ends any other session, or all others at once, without signing out (feat-233).

Sources: the contract in [`contracts/account.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/account.ts), the answers in [`responses/account-sessions-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/account-sessions-controller.ts), the User-Agent parser [`utils/user-agent.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/utils/user-agent.ts); in the backend [`account-sessions-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/user/account-sessions-controller.ts), [`session-list-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/session-list-service.ts) and the index in [`session-index.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/session-index.ts) ([Authentication → Session list](/en/backend/auth#session-list)).

| Route                                      | Middleware                                | What it does                                                                                          |
| ------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/account/sessions?cursor=<c>`     | `session_web`, `csrf_guard`, `auth_guard` | the current session apart, then a page of the others, newest first                                    |
| `DELETE /api/account/sessions/:id`         | `session_web`, `csrf_guard`, `auth_guard` | ends one other session; the current one answers `409` with `reason: "current_session"` (use a logout) |
| `POST /api/account/sessions/revoke-others` | `session_web`, `csrf_guard`, `auth_guard` | ends every session but this one, which is renewed                                                     |

No re-authentication: both actions only reduce access, and a victim whose session somebody else holds must be able to use them.

### The list

```json
{
    "status": "success",
    "current": {
        "id": "Qm9vZ1hY2c3Rk5nXyZt-Aw",
        "current": true,
        "browser": "Chrome",
        "os": "macOS",
        "deviceType": "desktop",
        "userAgent": "Mozilla/5.0 (Macintosh; …) Chrome/131.0.0.0 Safari/537.36",
        "ip": "203.0.113.7",
        "method": "oauth",
        "provider": "github",
        "signedInAt": "2026-11-19T10:00:00.000Z",
        "lastSeenAt": "2026-11-19T12:00:00.000Z",
        "online": true
    },
    "others": [],
    "nextCursor": null
}
```

- `id` is a **public id**, 22 base64url characters of `HMAC-SHA256(APP_KEY, sessionId)`. The session id itself (it travels in logs, WS tokens and `user_online`) is never sent. The public id is computed once, when the session is created, and stored with it, so nothing computes it again.
- `browser`, `os` and `deviceType` come from the User-Agent, read when the list is read, by a parser of `shared` that the sign-in mail uses too (no dependency: `ua-parser-js` v2 is AGPL). What it cannot tell is `unknown`; the raw `userAgent` (cut to 512 characters) is next to it. The IP is shown in full: it is the user's own data.
- `method`: `password` (email or phone), `oauth` with `provider`, `register` (an email or phone registration). A renewed session (password change, "end all other sessions") keeps the method, the sign-in time, the IP and the User-Agent it came from.
- `lastSeenAt` is accurate to an hour (below). `online` means a WebSocket of this session is open on the instance that answered (below).
- `current` is filled on the first page only (no `cursor`), `null` on the next ones; it is never among `others`. There is no `total`: it could not be exact without checking every member.

**Pages.** 50 sessions a page, ordered by `(createdAt desc, publicId desc)`. `nextCursor` is the opaque position (`base64url("<createdAt>:<publicId>")`) of the last member **looked at**, live or dead, or `null` once the list is exhausted. A page reads at most 500 members (a constant, as are 50 and the batch of 64); if it stops there it may be shorter than 50, even empty, and still have a cursor: "Show more" goes on from exactly that place. A dead member (no meta field, no record, older than `SESSION_MAX_AGE_DAYS`) is dropped on the way. An ended session moves no border, a new one appears above what is shown, and a live session keeps its place, so nothing is skipped or repeated. A cursor the server never gave out answers `400`.

### Ending one session

As a logout of that session would (feat-210): its record goes with its index member, its sockets on this instance close at once (4001), those on other instances at the next re-check (≤ `WS_SESSION_RECHECK_INTERVAL_MS`). No token is rotated. An unknown id, an id of another user and a session ended already all answer `404`, without telling them apart; the frontend takes a `404` as done. The session that asks must still have its record (a logout in another tab deletes it): otherwise `401 session_revoked`. Every device gets the push `session_revoked`.

### Ending all other sessions

The path of a password change, without the password:

1. the session that asks must still have its record, else `401 session_revoked`;
2. one transaction: `users.session_token` is rotated only while it is the presented one (`updateIfSessionToken`, ADR 0002, feat-096), and the pending password-reset links and SMS challenges of the phone are retired with it (`retirePendingResets`, shared with logout-all and the password change). If the row was not updated: the user is gone (`404`) or the token was rotated meanwhile (`401 session_revoked`);
3. the sockets of every other session close; those of this one stay for the client to replace;
4. the records of the old token are deleted (memory cleanup only: the rotation already revoked them);
5. this session is renewed under the rotated token, keeping its device.

The answer is a partial success, as for a password change: `{ status: "success", sessionRenewed: true, csrfToken, wsUrl, wsToken }`, or `{ status: "success", sessionRenewed: false }` when the others are ended but the renewal failed (for example Redis went down): the sockets of this session then close too and the client signs in again. Every device gets the push `logout_all`.

**Races** between two sessions of the same user: exactly one rotation wins.

| First (wins)      | Second (loses)    | What the second gets                                                                           |
| ----------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `revoke-others`   | `revoke-others`   | its session is revoked: `401 session_revoked`, or `403 token_mismatch` once its record is gone |
| `revoke-others`   | `logout-all`      | the same                                                                                       |
| `logout-all`      | `revoke-others`   | the same                                                                                       |
| `revoke-others`   | `change-password` | the same; the password is not changed                                                          |
| `change-password` | `revoke-others`   | the same                                                                                       |
| `change-password` | `change-password` | `409` "Password was changed by another request", unchanged                                     |

**Requests of the same session.** A renewal deletes the session other requests of the page were sent from, so they get a `401` that does not mean the user is signed out. The frontend (`base-api.ts`, option `renewsSession` on `revoke-others` and `change-password`) treats a `401` as stale when the CSRF token it was sent with is one a renewal replaced: it reaches its caller as `clientCode: "session_renewed"`, a safe `GET` is sent once more from the renewed session, a change is not ("Try again"). A `401` that arrives while a renewal is in flight waits for it, so the order of the answers does not matter; when the renewal fails, the waiting `401`s sign the user out as usual. A change that meets `csrf_guard` once the old record is gone gets `403 token_mismatch`; its CSRF recovery waits for a renewal in flight too before it reads `main/init` (feat-234), then sends the change once more from the renewed session.

### Live updates

The broadcast event `user_sessions_changed` (no data) goes through the user event bus to every connection of the user ([WebSocket → Events to a user on every instance](/en/backend/websocket#events-to-a-user-on-every-instance)) on a sign-in, a logout, a renewal, an ended session, "end all others", and when the first socket of a session opens or its last one closes. The client reads the first page again on it (events close together are read once, 300 ms) and on every `service:connection_ready`, since the bus does not replay. Changes of `lastSeenAt` send no event.

## Notification preferences

The account page shows the category × channel matrix of the notification center (`GET`/`PUT /notifications/preferences`): the security and support push is turned on or off for every device, and the security mail is shown locked. The push toggle next to it subscribes this device only. See [Notification center](/en/backend/notifications#channels-and-preferences).

### `lastSeenAt` and `online`

`lastSeenAt` is written beside the record, never into it: with the hourly cookie refresh of an HTTP request (a failed write gives the refresh marker back, so the next request tries again), when a WebSocket opens, and after an authenticated WS message (not a heartbeat) at most every 15 minutes per connection, the time moving only after a successful write. While Redis writes succeed it lags the last action by at most an hour; the page shows it to the hour ("less than an hour ago", "3 h ago", "yesterday", a date).

`online` comes from the WebSocket connection registry of the instance in memory, not from `user_online`. With one app container (as in `docker-compose.yml`) it is exact; with several instances a session whose socket is on another one shows offline.

::: warning Plan
No IP geolocation (it needs an outside database and its license), and no history of sign-ins beyond the lifetime of a session: that is item 3 of the recommendations ("Log of important actions").
:::

### Verification

```bash
curl -s -b cookies.txt $B/account/sessions
curl -s -b cookies.txt -X DELETE -H "$O" -H "x-csrf-token: $CSRF" $B/account/sessions/<id>
curl -s -b cookies.txt -c cookies.txt -X POST -H "$O" -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF" -d '{}' $B/account/sessions/revoke-others
```

Tests: [`session-index.redis.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/vendor/utils/session/session-index.redis.test.ts) (scripts, pages, ties, dead members), [`account-sessions-http.pg.test.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-sessions-http.pg.test.ts) (routes, sockets, races), [`session-list-service.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/session-list-service.spec.ts); in the frontend [`base-api-session-renewal.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/utils/__tests__/base-api-session-renewal.spec.ts), [`ActiveSessions.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/src/components/account/__tests__/ActiveSessions.spec.ts) and [`e2e-live/active-sessions.spec.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/frontend/e2e-live/active-sessions.spec.ts).
