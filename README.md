# FinOpsX

AI-powered financial operations and intelligence platform.

**Monitor. Investigate. Understand.**

**Live demo:** [finopsx.vercel.app](https://finopsx.vercel.app)

**FinOpsX — Demo Environment · Synthetic Data Only.** Conceptual fintech operations platform. Not affiliated with or endorsed by F1Soft.

FinOpsX is not an F1Soft product or internal system, it does not use real customer data, real bank or payment credentials, and it does not connect to private banking systems. Every institution (Demo Bank A/B/C, Demo Wallet, Demo Payment Network, Demo Merchant Network), merchant, transaction, and metric in the app is synthetic.

The workflow it demonstrates: **Monitor → Detect → Investigate → Explain → Act → Resolve → Reconcile → Report → Audit.**

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

- Demo login, refresh-token rotation, lockout, forgot/reset password, rate-limited auth
- Server-enforced role permissions for Super Admin, Operations Manager, Analyst, Engineer, and Auditor
- Overview with live metrics over Socket.IO (Live / Reconnecting / Offline indicator, snapshot refetch on reconnect)
- Server-side paginated transactions with a lifecycle timeline (Initiated → Authenticated → Processing → Bank response → Settlement → Completed), event log, API calls, and ledger match
- API observability: P50 / P95 / P99, error rate, and availability per endpoint from recorded API calls
- Incident lifecycle Detected → Acknowledged → Investigating → Identified → Mitigating → Resolved → Post-incident review, with assignment, severity, notes, reopen, and audited transitions
- Operational Anomaly Detection (moving-average baselines, z-scores, threshold fallback) with normal vs observed values and evidence — not fraud detection
- AI root cause analysis that states a "Likely cause" with evidence and limitations
- FinOpsX AI Operations Assistant grounded in database tool results, with links to records; it answers "I don't have enough data to answer that." when the data is missing
- Ask Your Data: questions are parsed into a validated structured query (no raw SQL), with CSV export
- Reconciliation (Matched / Mismatch / Investigating / Resolved) against a synthetic institution ledger and settlement batches
- EOD/BOD operational jobs on schedule or triggered manually
- Data quality checks with drill-down to affected records
- FinOpsX Demo Service Architecture map with upstream impact
- Demo Infrastructure Metrics (measured process metrics vs labeled simulated figures)
- Seven report types with in-browser view, PDF, CSV, and Excel downloads
- Demo Simulator with six scenarios and a chain-reaction view (degradation → anomaly → incident → notification)
- Audit log, notifications, global search, user administration, thresholds
- OpenAPI at `/api/docs` (all endpoints)

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
npm run db:migrate
npm run db:seed
```

Migrations are committed under `prisma/migrations`. `SEED_TRANSACTION_COUNT` defaults to 20000. Set it to `50000` for the full demo scale. Seeding again wipes and recreates demo data. It refuses to run in production unless `ALLOW_DEMO_SEED=true`.

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
| `ALLOW_DEMO_SEED` | Allow seeding when `NODE_ENV=production` (hosted demo only) |
| `SHOW_DEMO_ACCOUNTS` | List the synthetic accounts on the hosted login page |
| `SIMULATOR_AUTOSTART` | Start synthetic traffic on boot (default `true`) |
| `TRANSACTION_RETENTION_DAYS`, `MAX_TRANSACTIONS` | Prune old synthetic rows |

GitHub Actions deploy secrets (optional; each step is skipped when unset): `RENDER_DEPLOY_HOOK_URL`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

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

Super Admin and Engineer can start, stop, reset, and tune the simulator (transactions per minute, failure/pending/high-value rates, average amount) from the Demo Simulator page. Reset restores rates and ends a scenario. It does not delete the ledger. Scenarios:

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
npm run lint                                    # TypeScript checks for server and client
npm test                                        # server unit + integration (needs a seeded DB) and client tests
node scripts/smoke-api.mjs http://localhost:4000/api --scenario   # 95 live API checks incl. a scenario chain
npm run test:e2e
```

Server tests cover anomaly statistics, PDF/CSV output, the Ask Your Data parser and whitelist (SQL is refused, never executed), the "not enough data" answer, assistant routing, incident transitions, service impact, report titles, simulator timeouts, secure headers, secret-free health output, 401 for missing/forged tokens, RBAC (403 per role), validation (400/422), malformed JSON, and the incident lifecycle with audit entries and 404/422. The smoke script additionally exercises reconciliation, jobs, reports and downloads, audit capture, and a full Bank API latency scenario chain against a running API. Client tests cover formatting, the permission matrix, navigation per role, demo labels, and the incident, anomaly, and assistant pages. Install browsers with `npx playwright install chromium` before the Playwright run.

CI (`.github/workflows/ci.yml`) runs install → Prisma generate → shared build → lint → migrate + seed (Postgres service) → tests → build → client bundle secret scan. The deploy job only runs on `main` after the test job passes, and Render's `autoDeployTrigger: checksPass` waits for the checks as well.

## Build and deployment

```bash
npm run build
```

The client is a static Vite build. `vercel.json` builds `client/dist` and rewrites app routes to `index.html`. Set `VITE_API_URL` and `VITE_SOCKET_URL` to the public API before the production build.

`render.yaml` defines the API web service and a PostgreSQL database. The start command migrates, seeds synthetic data only when the database is empty, then listens on `0.0.0.0`. Set `NODE_ENV=production`, real JWT secrets, `ALLOW_DEMO_SEED=true`, and `SHOW_DEMO_ACCOUNTS=true` for the public demo. `CLIENT_URL` should be the Vercel origin. HTTPS origins on `*.vercel.app` are also accepted so preview deploys can call the API. Redis stays optional.

## Security notes

Passwords are hashed with bcrypt. Refresh tokens are rotated and stored as hashes. Routes check roles on the server. Helmet, request IDs, Zod validation, Prisma parameter binding, and rate limits are enabled. Logs omit passwords, tokens, and raw customer data. Customer identifiers in the demo are already masked.

## Known limitations

- Demo Infrastructure Metrics: replication lag, slow queries, and cache usage are simulated and labeled as such; API process CPU and memory, host memory, event-loop lag, database connections and size, and the pending queue are measured.
- Anomaly detection is operational monitoring, not a fraud platform.
- Seeded history is sparser than the live simulator rate, so charts show a step up once the simulator is running.
- The assistant uses the local analysis engine unless `AI_PROVIDER=openai` and `AI_API_KEY` are set.
- Email is disabled unless SMTP is configured. Scheduled reports then record a simulated delivery status.
- The full 50,000-row seed is supported through `SEED_TRANSACTION_COUNT` and takes longer than the 20,000 default.
- `POST /api/dev/reset-demo` only authorizes a super admin outside production. Reseeding is `npm run db:seed`.
- Swagger content security policy is relaxed on `/api/docs` so the UI can load.
