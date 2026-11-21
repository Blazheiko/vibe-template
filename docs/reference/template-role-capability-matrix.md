# Role Capability Matrix: vibe-template

Last updated: 2026-11-21

Roles in code (`users.role`, catalog `packages/shared/src/access/index.ts`): `user`, `support_operator`
(Support), `kb_editor` (KB), `user_admin` (Users), `admin`. The public page with how each row is
enforced: `documentation/reference/roles-capabilities.md`.

| Capability                           | Anonymous | user | Support | KB  | Users | admin    | Developer/QA  | Operator             |
| ------------------------------------ | --------- | ---- | ------- | --- | ----- | -------- | ------------- | -------------------- |
| View public auth and policy pages    | Yes       | Yes  | Yes     | Yes | Yes   | Yes      | Yes           | Yes                  |
| Register/login/reset password        | Yes       | N/A  | N/A     | N/A | N/A   | N/A      | Test          | Configure            |
| OAuth login                          | Yes       | N/A  | N/A     | N/A | N/A   | N/A      | Test          | Configure providers  |
| Access protected app shell           | No        | Yes  | Yes     | Yes | Yes   | Yes      | Test          | N/A                  |
| Update account/profile               | No        | Yes  | Yes     | Yes | Yes   | Yes      | Test          | N/A                  |
| Link phone/email                     | No        | Yes  | Yes     | Yes | Yes   | Yes      | Test          | Configure providers  |
| Upload/delete avatar                 | No        | Yes  | Yes     | Yes | Yes   | Yes      | Test          | Configure storage    |
| Use support chat                     | No        | Yes  | Yes     | Yes | Yes   | Yes      | Test          | Configure AI/storage |
| Manage push subscriptions            | No        | Yes  | Yes     | Yes | Yes   | Yes      | Test          | Configure VAPID      |
| View admin shell                     | No        | No   | Yes     | Yes | Yes   | Yes      | Test per role | N/A                  |
| Read knowledge base (`kb.read`)      | No        | No   | Yes     | Yes | No    | Yes      | Test          | Seed/import data     |
| Edit KB articles (`kb.write`)        | No        | No   | No      | Yes | No    | Yes      | Test          | N/A                  |
| Reindex all / init KB (`kb.manage`)  | No        | No   | No      | No  | No    | Yes      | Test          | Seed/import data     |
| Manage AI prompts (`prompts.manage`) | No        | No   | No      | No  | No    | Yes      | Test          | Configure AI         |
| View AI usage (`ai_usage.read`)      | No        | No   | No      | No  | No    | Yes      | Test          | N/A                  |
| View users and online (`users.read`) | No        | No   | Yes     | No  | Yes   | Yes      | Test          | N/A                  |
| Connection details, online history   | No        | No   | No      | No  | No    | Yes      | Test          | N/A                  |
| Audit log: sign-in and sessions      | No        | No   | Yes     | No  | Yes   | Yes      | Test          | N/A                  |
| Full audit log (`audit.read`)        | No        | No   | No      | No  | Yes   | Yes      | Test          | N/A                  |
| Assign roles (`users.roles.assign`)  | No        | No   | No      | No  | Yes\* | Yes\*    | Test          | CLI `user:set-role`  |
| Use API playground                   | No        | No   | No      | No  | No    | Optional | Yes           | Optional             |
| Run database migrations              | No        | No   | No      | No  | No    | No       | Local only    | Yes                  |
| Configure environment/deploy         | No        | No   | No      | No  | No    | No       | Local only    | Yes                  |

\* `PATCH /admin/users/:id/role` and the "Change role" dialog of `/admin/users`; `user_admin` may give
and take only `user`, `support_operator` and `kb_editor`, nobody changes their own role. The CLI
`user:set-role` (server access) gives the first roles and recovers a lost administrator.
