# Constraints and Assumptions: vibe-template

Last updated: 2026-05-30

## 1. External Dependencies

| Dependency            | Requirement                | Notes                                                                   |
| --------------------- | -------------------------- | ----------------------------------------------------------------------- |
| Node.js               | Required                   | Workspace requires Node `^24.22.2`.                                     |
| pnpm                  | Required                   | Workspace uses pnpm 9.x through `packageManager`.                       |
| PostgreSQL            | Required                   | Primary persistence through Drizzle ORM.                                |
| Redis                 | Required for full behavior | Sessions, rate limits, presence, and coordination.                      |
| S3-compatible storage | Feature-dependent          | Avatars and knowledge base screenshots.                                 |
| SMTP                  | Feature-dependent          | Verification and reset email delivery.                                  |
| OAuth providers       | Feature-dependent          | Provider credentials are deployment-specific.                           |
| SMS provider          | Feature-dependent          | Phone auth is disabled by default and fake provider is local/test only. |
| AI providers          | Feature-dependent          | Support AI, embeddings, prompt tests, and usage tracking.               |
| Sentry                | Optional                   | Error and performance monitoring.                                       |

## 2. Product Assumptions

| ID         | Assumption                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ASSUMP-001 | The template is single-tenant by default. Multi-tenancy is not described as a built-in product contract.                                     |
| ASSUMP-002 | The user model is intentionally simple: regular user and administrator.                                                                      |
| ASSUMP-003 | The template provides starter policies and policy pages, not legal compliance guarantees.                                                    |
| ASSUMP-004 | Production infrastructure such as load balancers, TLS termination, backups, and secret management is supplied by the deployment environment. |
| ASSUMP-005 | Optional features can be removed or disabled when a downstream product does not need them.                                                   |

## 3. Deployment Constraints

- Production deployments should set `APP_IS_PRODUCTION=true`.
- Public deployments should use HTTPS and secure cookies.
- `TRUST_PROXY` should be enabled only behind trusted ingress infrastructure.
- `CSRF_ENFORCE=true` should be enabled after report-only validation.
- Secrets must remain in environment or secret stores, never committed to the repository.
