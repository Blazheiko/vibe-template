# Two-step sign-in (MFA)

An account can have a second factor: an authenticator app (TOTP), passkeys (WebAuthn) and one-time recovery codes. A passkey also signs in on its own, without a password. After the password or a social sign-in such an account gets a second-step ticket instead of a session; only the right code creates the session. Sensitive actions (changing the password, linking contacts, removing a sign-in method, managing the factors) are confirmed again (step-up) by one matrix. A recovery code opens a limited recovery session in which the only thing to do is to replace the factor.

Plan and decisions: [`docs/plan/passkeys-mfa-plan.md`](https://github.com/Blazheiko/vibe-template/blob/main/docs/plan/passkeys-mfa-plan.md). Sources: the shared policy [`shared/src/mfa`](https://github.com/Blazheiko/vibe-template/tree/main/packages/shared/src/mfa), the services [`services/auth/mfa`](https://github.com/Blazheiko/vibe-template/tree/main/packages/backend/src/app/services/auth/mfa), the contracts [`contracts/mfa.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/mfa.ts), [`contracts/passkeys.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/passkeys.ts) and [`contracts/auth.ts`](https://github.com/Blazheiko/vibe-template/blob/main/packages/shared/src/contracts/auth.ts).

::: warning Planned
Mandatory MFA for staff and the administrator's MFA reset are `feat-247`; the passkey-only mode for staff is `feat-248`.
:::

## Routes

| Route                                    | Middleware                                | What it does                                                                                                 |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST /api/auth/mfa/verify`              | `session_web`, `csrf_guard`               | the second sign-in step: `{ method: 'totp' \| 'recovery_code', code }` or `{ method: 'webauthn', response }` |
| `POST /api/auth/mfa/webauthn/options`    | `session_web`, `csrf_guard`               | the options of a passkey signature for the second-step ticket                                                |
| `POST /api/auth/passkey/options`         | `session_web`, `csrf_guard`               | the options of a passkey-only sign-in and a `challengeId`                                                    |
| `POST /api/auth/passkey/verify`          | `session_web`, `csrf_guard`               | a passkey-only sign-in: `{ challengeId, response }`                                                          |
| `POST /api/auth/reauth/options`          | `session_web`, `csrf_guard`, `auth_guard` | the step-up proofs this account can give                                                                     |
| `POST /api/auth/reauth`                  | `session_web`, `csrf_guard`, `auth_guard` | step-up: `{ proof: 'password', password }`, `{ proof: 'totp', code }` or `{ proof: 'webauthn', response }`   |
| `POST /api/auth/reauth/webauthn/options` | `session_web`, `csrf_guard`, `auth_guard` | the options of a passkey step-up (the challenge in this session's data)                                      |
| `POST /api/auth/recovery/finish`         | `session_web`, `csrf_guard`, `auth_guard` | ends the recovery session                                                                                    |
| `GET /api/account/mfa`                   | `session_web`, `csrf_guard`, `auth_guard` | the factors, the codes left, whether a recovery contact exists                                               |
| `POST /api/account/mfa/totp/setup`       | the same                                  | a new secret (in this session's data, 10 min) and an `otpauth://` URI                                        |
| `POST /api/account/mfa/totp/confirm`     | the same                                  | checks the code and stores the factor; replaces the previous app                                             |
| `DELETE /api/account/mfa/totp`           | the same                                  | turns TOTP off; the last factor takes the recovery codes along                                               |
| `POST /api/account/mfa/recovery-codes`   | the same                                  | a new batch of codes; the previous one stops working                                                         |
| `GET /api/account/passkeys`              | the same                                  | the account's passkeys (name, type, synced, created, last used)                                              |
| `POST /api/account/passkeys/options`     | the same                                  | the options of a new passkey and an `enrollmentId` (the challenge in this session's data)                    |
| `POST /api/account/passkeys`             | the same                                  | stores the new passkey; idempotent by `enrollmentId`                                                         |
| `PATCH /api/account/passkeys/:id`        | the same                                  | renames a passkey                                                                                            |
| `DELETE /api/account/passkeys/:id`       | the same                                  | removes a passkey; the last way to sign in stays                                                             |

The browser draws the QR code (`qrcode`); the secret never goes to another service.

## The second sign-in step

`POST /api/auth/login` (and the OAuth callback) answers an account with a factor `{ status: 'mfa_required', methods }` (a passkey first when there is one) and sets the ticket cookie `__Host-mfa` (`mfa` without HTTPS): `HttpOnly`, `SameSite=Strict`, 5 min. OAuth redirects to `OAUTH_FRONTEND_MFA_URL` (by default `/login?mfa=required`) with the account's methods: `&methods=webauthn,totp,recovery_code`. The ticket is bound to the browser's session cookie, so a stolen ticket opens nothing in another browser.

- Five wrong codes close the ticket. The limit counts confirmed failures, not requests: an infrastructure failure gives the attempt back.
- A TOTP code is spent for one version of the factor (`last_used_step`), so the same code is refused the second time.
- The request that captured the ticket creates the session: first as `pending` before the commit, then in one Redis transition. A repeat of the same request (a lost answer, 503 `mfa_completion_pending`) finishes an already confirmed sign-in with the same session; an unknown `COMMIT` outcome is read with `pg_xact_status`.
- A new social sign-in linked to an account with MFA is stored only after the TOTP second step; a recovery-code sign-in does not store it.

**What is guaranteed for the last recovery code.** The ticket lives in Redis. A failed activation, a briefly unreachable Redis and a lost answer do not lose the code. Losing the whole Redis together with the ticket (or the database or Redis being down for the whole 5 minutes of the ticket) after the commit leaves the code spent without a session; an administrator helps then. So Redis in production should persist (AOF).

## Passkeys

The library is [`@simplewebauthn`](https://simplewebauthn.dev/) (`server` in the backend, `browser` in the frontend, exact versions). One function, [`verifyWebAuthnCeremony`](https://github.com/Blazheiko/vibe-template/blob/main/packages/backend/src/app/services/auth/mfa/webauthn-ceremony.ts), checks every browser answer the same way for registration, passwordless sign-in, the second step and step-up (an architecture test keeps the library calls there):

- user verification (UV) required: a fingerprint, a face or the device PIN;
- the exact `origin` of the `WEBAUTHN_ORIGINS` list and the exact `WEBAUTHN_RP_ID`;
- a challenge of its purpose and binding: `register:<sessionId>`, `login`, `mfa:<ticket hash>`, `reauth:<sessionId>`; one-time (`GETDEL` in Redis or an atomic consume of the session data);
- the key belongs to the expected user; in a passwordless sign-in the answer's `userHandle` equals the owner's random `users.webauthn_user_handle` (not the id, not the email);
- the signature counter: `0` on both sides is fine (synced passkeys), otherwise it only grows (a conditional `UPDATE`). A regression is refused and recorded as `auth.passkey.counter_regressed`; the key stays, the owner decides.

**Registration.** `POST /account/passkeys/options` (rows 1–2 of the matrix; the first factor needs a verified contact, 409 `recovery_contact_required`) puts the challenge and an `enrollmentId` into the session data. `POST /account/passkeys` checks the answer and stores the key; a repeat after the commit returns the same key, and another key for a finished registration is 409 `enrollment_used`. A first passkey issues the recovery codes. At most 20 keys (409 `passkey_limit`), attestation `none`, `residentKey: required`. Removal (row 3), under the user's row lock, never leaves the account without a way to sign in (409 `last_sign_in_method`).

**A passkey-only sign-in** is a full level-2 sign-in (`amr: ['webauthn']`) with no second step. An unknown key, a bad signature and a foreign `userHandle` answer the same 401. The sign-in page also offers the passkey in the autofill of the identifier field (conditional UI, `autocomplete="username webauthn"`).

::: warning The RP ID does not change
A passkey is bound to its RP ID for good. Changing `WEBAUTHN_RP_ID` after the launch makes every registered passkey unusable (the password, TOTP and the codes stay). That is why a production-like environment names it explicitly instead of deriving it from a URL.
:::

## Step-up

The session keeps `auth`: the level of the sign-in (`aal` 1 or 2, never raised), the sign-in methods (`amr`) and when each method was last proven. An action of the matrix asks whether the needed proof is fresh (`AUTH_REAUTH_WINDOW_SECONDS`, 300 s by default) and answers `403 { reason: 'reauth_required', details: { kind: 'reauth_required', proofs } }`; the client shows a dialog with just those proofs and repeats the request.

| Action                                     | Without MFA                                                  | With MFA                |
| ------------------------------------------ | ------------------------------------------------------------ | ----------------------- |
| Turn on the first factor                   | a fresh password (or a social sign-in ≤ 10 min, no password) | —                       |
| Add / replace a factor                     | —                                                            | a fresh TOTP or passkey |
| Turn a factor off, new codes               | —                                                            | a fresh TOTP or passkey |
| Change the password, link a phone or email | a fresh password (or a recent social sign-in)                | a fresh TOTP or passkey |
| Remove a social sign-in                    | the same                                                     | a fresh TOTP or passkey |
| End other sessions                         | the session only                                             | the session only        |

For an account with MFA the password alone confirms nothing. Linking a phone or an email is confirmed at its start; the SMS code or the link finish it without another step-up, but any change of the MFA state voids the links still pending.

The first factor needs a verified email (or a phone with `AUTH_PHONE_ENABLED`): through it the user sets a password again after losing access.

## Recovery

- An ordinary password reset does **not** turn MFA off. The owner of an unverified address taking the account over (`claimLocked`) removes the factors with everything else set up before the proof.
- A recovery code (16 characters, 80 bits, one-time) opens a **recovery session**: level 1, an absolute lifetime `MFA_RECOVERY_WINDOW_SECONDS` (900 s by default), no WebSocket. The other sessions end. Only `main/init`, the `/account/mfa/*` routes, `recovery/finish` and `logout` are allowed; everything else answers `403 recovery_session`. Removing the old factor or new codes come only after the factor was replaced. After finishing, an ordinary sign-in with the new factor.

## Configuration

| Variable                                | Default                      | What it sets                                                                                                        |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MFA_ENCRYPTION_KEYS`                   | —                            | `<keyId>:<base64 of 32 bytes>[,…]`; required in production-like                                                     |
| `AUTH_REAUTH_WINDOW_SECONDS`            | `300`                        | how long a step-up counts                                                                                           |
| `MFA_RECOVERY_WINDOW_SECONDS`           | `900`                        | the lifetime of a recovery session                                                                                  |
| `MFA_TICKET_TTL_SECONDS`                | `300`                        | the lifetime of a second-step ticket                                                                                |
| `MFA_RESERVATION_TTL_SECONDS`           | `30`                         | how long an attempt holds its place in the ticket                                                                   |
| `AUTH_MFA_VERIFY_MAX_ATTEMPTS_PER_USER` | `10`                         | second-step and step-up codes per user per window                                                                   |
| `AUTH_MFA_VERIFY_WINDOW_SECONDS`        | `900`                        | the window of that limit                                                                                            |
| `OAUTH_FRONTEND_MFA_URL`                | `/login?mfa=required`        | where OAuth sends an account with a second factor                                                                   |
| `WEBAUTHN_RP_ID`                        | the host of `FRONTEND_URL`   | the RP ID of the passkeys; required in production-like, never changed after the launch                              |
| `WEBAUTHN_RP_NAME`                      | `APP_NAME`                   | the name in the passkey dialog                                                                                      |
| `WEBAUTHN_ORIGINS`                      | the origin of `FRONTEND_URL` | the exact origins of the ceremonies, comma-separated (`https://` in production-like), each on the RP ID or below it |

The TOTP secret is stored encrypted (AES-256-GCM, the owner as associated data). The first key of the list encrypts, the others read, so keys rotate without re-encrypting everything. Without `MFA_ENCRYPTION_KEYS` outside production a key is derived from `APP_KEY` (with a warning in the log). Losing every key makes every TOTP factor unusable.

## Audit log and notifications

The events `auth.mfa.totp.enabled|replaced|disabled`, `auth.mfa.recovery_codes.regenerated`, `auth.mfa.recovery_code.used`, `auth.passkey.added|removed|counter_regressed` go to the [audit log](./audit-log) with their proof (`metadata.proof`). Every change of the factors sends a security notification and a mail to the account's address.
