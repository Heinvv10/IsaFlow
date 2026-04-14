# Pre-flight Snapshot — 2026-04-14

## Environment

| Key | Value |
|---|---|
| Branch | `master` |
| HEAD | `2537572008d8ac117dcdba8df684b8f68de66f88` |
| Node | `v22.22.0` |
| Bun | `1.3.9` |
| `DATABASE_URL` target | dev (Neon `neondb` branch — 22 companies / 22 users, NOT prod) |
| Dev server | `http://localhost:3200` (started via `bun run dev`, PID 1367522, logs `/tmp/isaflow-dev.log`) |
| Admin token | `/tmp/isaflow-admin-token.env` (2h expiry, `super_admin`, user `00000000-0000-0000-0000-000000000099`) — validated via `GET /api/auth/me` |

## Pre-flight findings (already surfaced — route to correct audit streams)

These are incidentally discovered during preflight and should be included in their respective Phase 1 reports:

1. **[P3 → code-quality]** `.env.local` has a duplicate `NEXT_PUBLIC_APP_URL` — line 7 `http://localhost:3101`, line 21 `https://app.isaflow.co.za`. Later entry wins in dotenv parsing, so local dev builds ship with the prod URL baked in. Config hygiene issue.
2. **[P2 → code-quality]** `package.json` script `dev` runs on port **3200**, but `.env.local` line 7 says `NEXT_PUBLIC_APP_URL=http://localhost:3101`. Port drift — neither matches the other.
3. **[P2 → code-quality]** Next.js emits on startup:
   > `Duplicate page detected. pages/accounting/bank-feeds.tsx and pages/accounting/bank-feeds/index.tsx resolve to /accounting/bank-feeds`
   Two files resolve to the same route. One must be dead/shadowed.
4. **[P3 → code-quality]** `scripts/mint-for-admin-qa.ts` uses top-level await but fails under `bunx tsx` (CJS transform). Works under `bun run` only. Either refactor to async main or document the run command.
5. **[P3 → code-quality]** `scripts/mint-for-admin-qa.ts` has a hard-coded absolute import path `/home/hein/Workspace/IsaFlow/src/lib/neon.ts` — breaks on any other developer's machine.

## Migrations

`bun run db:migrate` → `=== Migration complete ===`. All pending migrations applied. (Full list elided — `schema_migrations` table up to date.)

## Baseline type-check

`bunx tsc --noEmit` → **zero errors**. Clean baseline.

## Demo data counts (verified against dev DB)

| Company | ID | CI | SI | Bank Tx | Customers | Suppliers | CI date span |
|---|---|---:|---:|---:|---:|---:|---|
| ISAFlow Demo (Pty) Ltd | `00000000-0000-0000-0000-000000000001` | 606 | 577 | 877 | 61 | 35 | 2024-02 → 2027-03 |
| Brightsphere Technologies (Pty) Ltd | `d27bac33-cdc0-4e58-bf6b-709c1597d41c` | 132 | 17 | 8,114 | 7 | 5 | 2023-03 → 2026-03 |

## Tools installed for audit

- `autocannon@8.0.0` (devDependency) — HTTP load generator for Task 1C

## Helper scripts created

- `scripts/audit-2026-04-14/mint-admin-token.sh` — re-mint JWT on demand
