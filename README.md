# FinOpsX

AI-powered financial operations and intelligence platform.

**Monitor. Investigate. Understand.**

**Live demo:** [finopsx.vercel.app](https://finopsx.vercel.app)

FinOpsX is a conceptual fintech operations console inspired by studying publicly available information about modern fintech infrastructure and F1Soft's publicly described business domains. It is not an F1Soft product, it does not use real customer data, and it does not connect to private banking systems. Every institution, merchant, transaction, and metric in the app is synthetic.

The public site uses a scroll-pinned sky motion: giant type, letter scatter, a moving gradient, and a particle field. It does not use photographic or 3D product images. The signed-in console is a dense operations workspace.

## Architecture

```
Simulator
  → transaction generator
  → processor + PostgreSQL
  → metrics
  → anomaly detector (rules, moving average, z-score, isolation-style score)
  → incident rules
  → notifications
  → Socket.IO
  → dashboard
```

The browser talks to an Express REST API and a Socket.IO channel. Prisma owns the PostgreSQL schema. Redis is used for live counters and rate limits when it is available; the API keeps working with an in-memory fallback and reports Redis as disabled or down. The assistant calls a fixed set of server tools. It cannot run SQL.

## Technology

- React, TypeScript, Vite, Tailwind, React Router, TanStack Query, Recharts, Lucide, React Hook Form, Zod
- Node.js, Express, Socket.IO, Prisma, PostgreSQL, Redis, JWT, bcrypt
- Vitest, Testing Library, Supertest, Playwright
- Docker Compose and GitHub Actions

## Features

- Demo login, refresh-token rotation, lockout, forgot/reset password
- Role permissions for Super Admin, Operations Manager, Analyst, Engineer, and Auditor
- Dashboard KPIs, volume and outcome charts, health score, service status
- Paginated transaction search, filters, sorting, and timelines
- Live simulator and six incident scenarios
- System health, institutions, anomalies, analytics, merchants
- Incident assignment, notes, resolution, deduplicated automatic incidents
- Reports with PDF, CSV, and Excel downloads from stored snapshots
- Operations assistant with mock answers from the database, optional OpenAI-compatible provider
- Audit log, notifications, global search, user administration, thresholds
- OpenAPI at `/api/docs`

## Folder structure

```
client/     React application
server/     Express API, simulator, assistant
shared/     Roles, permissions, currency formatting
prisma/     Schema and seed
tests/      Playwright journey
docker/     Container entrypoint
```

## Installation

Requirements: Node.js 20+, npm, and either Docker or the embedded PostgreSQL script.

```bash
cp .env.example .env
npm install
```

### Embedded PostgreSQL (no Docker)

In one terminal:

```bash
npm run db:embedded
```

Leave it running. The default URL is `postgresql://finopsx:finopsx_demo@127.0.0.1:5433/finopsx`.

### Database

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20261005000000_init/migration.sql
npm run db:migrate
npm run db:seed
```

After the first migration file exists, `npm run db:migrate` is enough. `SEED_TRANSACTION_COUNT` defaults to 20000. Set it to `50000` for the full demo scale. Seeding again wipes and recreates demo data. It refuses to run in production unless `ALLOW_DEMO_SEED=true`.

### Run locally

```bash
npm run dev
```

Open http://localhost:5173. The API listens on port 4000.

### Docker

```bash
docker compose up --build
```

The UI is published on http://localhost:8080 and the API on port 4000. Apply migrations automatically on server start. Seed once:

```bash
docker compose run --rm -e SEED_TRANSACTION_COUNT=20000 server node server/dist/seed.js
```

## Environment variables

See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL |
| `REDIS_URL` | Optional Redis |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Required in production |
| `AI_PROVIDER` | `mock` or `openai` |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | Optional provider |
| `CLIENT_URL` | Allowed browser origin |
| `PORT`, `NODE_ENV` | Server |
| `SMTP_*` | Optional email. Missing SMTP does not crash; delivery stays disabled |
| `VITE_API_URL`, `VITE_SOCKET_URL` | Browser endpoints. Empty in Vite dev uses the proxy |
| `SEED_TRANSACTION_COUNT` | Historical synthetic rows |

Never commit `.env`. The client bundle must not contain JWT secrets, database URLs, or AI keys.

## Demo accounts

Development only. Do not use these in production.

| Role | Email | Password |
| --- | --- | --- |
| Super Admin | admin@finopsx.demo | Admin@12345 |
| Operations Manager | operations@finopsx.demo | Operations@12345 |
| Analyst | analyst@finopsx.demo | Analyst@12345 |
| Engineer | engineer@finopsx.demo | Engineer@12345 |
| Auditor | auditor@finopsx.demo | Auditor@12345 |

The login page lists them only when `NODE_ENV` is not production.

## Simulator

Super Admin and Engineer can start, stop, and reset the simulator from the dashboard. Reset restores rates and ends a scenario. It does not delete the ledger. Scenarios:

1. Bank API latency spike
2. Payment failure spike
3. Settlement delay
4. Notification service degradation
5. High transaction volume
6. Merchant activity anomaly

Each one changes live synthetic transactions, can open an anomaly, and can trip an incident rule. Resolve scenario restores service status and resolves the matching open incident.

Default thresholds are demo-scale (`rpmGate` 40) so a local simulator can trip rules. Raise them in Settings for a stricter gate. The 10,000 requests/minute example in large payment estates is a production setting, not the local default.

## AI

`AI_PROVIDER=mock` answers from database tools: metrics, institutions, incidents, anomalies, hourly volume, failure reasons, transaction search, and report generation. If the OpenAI-compatible call fails or the key is missing, the same local analysis is used and the UI says the provider is unavailable. The assistant cannot delete data, move money, change roles, or execute SQL.

## Testing

```bash
npm test
npm run test:e2e
```

Unit tests cover currency formatting, permissions, anomaly scores, PDF content, and assistant routing. Playwright covers login, transactions, an incident update, the audit log, and the failure-rate question. Install browsers with `npx playwright install chromium` before the end-to-end run.

## Build and deployment

```bash
npm run build
```

The client is a static Vite build. `vercel.json` builds `client/dist` and rewrites app routes to `index.html`. Set `VITE_API_URL` and `VITE_SOCKET_URL` to the public API before the production build.

`render.yaml` defines the API web service and a PostgreSQL database. The start command migrates, seeds synthetic data only when the database is empty, then listens on `0.0.0.0`. Set `NODE_ENV=production`, real JWT secrets, `ALLOW_DEMO_SEED=true`, and `SHOW_DEMO_ACCOUNTS=true` for the public demo. `CLIENT_URL` should be the Vercel origin. HTTPS origins on `*.vercel.app` are also accepted so preview deploys can call the API. Redis stays optional.

## Security notes

Passwords are hashed with bcrypt. Refresh tokens are rotated and stored as hashes. Routes check roles on the server. Helmet, request IDs, Zod validation, Prisma parameter binding, and rate limits are enabled. Logs omit passwords, tokens, and raw customer data. Customer identifiers in the demo are already masked.

## Known limitations

- Infrastructure CPU, memory, and queue figures are simulated and labeled as such.
- Anomaly detection is a demonstration, not a fraud platform.
- Email is disabled unless SMTP is configured. Scheduled reports then record a simulated delivery status.
- The full 50,000-row seed is supported through `SEED_TRANSACTION_COUNT` and takes longer than the 20,000 default.
- `POST /api/dev/reset-demo` only authorizes a super admin outside production. Reseeding is `npm run db:seed`.
- Swagger content security policy is relaxed on `/api/docs` so the UI can load.
