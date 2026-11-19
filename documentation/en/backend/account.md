# Account and profile

The signed-in user changes their name, interface language and time zone, and their theme, color and font size are kept on the server, so they are the same on every device; an open tab or device gets a change without a reload (feat-232). Two routes do it: `GET /api/account/profile` and `PATCH /api/account/profile`. `GET /api/main/init` carries the same preferences, so the app applies them right after it starts.

Sources: the contract [`contracts/account.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/account.ts), the body [`schemas/account/update-profile.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/account/update-profile.ts) and the name rule [`profile-name.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/schemas/account/profile-name.ts), the answer [`responses/account-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/responses/account-controller.ts), the zone rule [`utils/time-zone.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/utils/time-zone.ts); in the backend [`account-controller.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/controllers/http/user/account-controller.ts), [`account-service.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/user/account-service.ts), [`user-preferences-repository.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/repositories/user/user-preferences-repository.ts) and [`profile-transformer.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/transformers/profile-transformer.ts).

## Routes

| Route                        | Middleware                                | What it does                                                                |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/account/profile`   | `session_web`, `csrf_guard`, `auth_guard` | the profile of the signed-in user                                           |
| `PATCH /api/account/profile` | `session_web`, `csrf_guard`, `auth_guard` | changes the passed fields and answers the profile as it is after the change |

Both answer `{ "status": "success", "profile": Profile }`:

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

After the commit, `PATCH` sends `broadcast:user_profile_updated` with the new `Profile` to every connection of the user on every instance, the tab that made the change and other tabs of the same session included ([WebSocket → Events to a user on every instance](/en/backend/websocket#events-to-a-user-on-every-instance)). The answer does not wait for it, and a failed event does not fail the change. The client applies it like any snapshot, by `revision`, under its unsaved changes, so an event that arrives late or twice changes nothing. Events are not replayed: after every WS connection, the first one included, the client reads `GET /account/profile` (a change made between the init snapshot and the socket would otherwise be missed).

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
