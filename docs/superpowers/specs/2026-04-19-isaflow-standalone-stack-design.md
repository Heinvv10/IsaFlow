# IsaFlow Standalone Supabase Stack — Design Spec

**Date:** 2026-04-19
**Status:** Approved for implementation
**Branch:** `infra/isaflow-standalone-stack`
**Rollback anchor (to be tagged pre-merge):** `v-pre-stack-split`

## Problem

IsaFlow currently shares the `/home/velo/supabase/` Docker stack on velo with 7 other projects (fibreflow, turnitout, impande, ndzinga_lms, apexgeo, apex_protocol, gaztime). Shared concerns:

- **Blast radius:** a bad migration or GoTrue config change on the shared `auth` container (which targets the shared `postgres` DB) can take down auth for all 8 projects simultaneously. Phase 2/3 cutover already hit this — `POSTGRES_DB=fibreflow` placeholder broke GoTrue for everyone until it was reset to `postgres`.
- **JWT_SECRET coupling:** all projects on the shared stack sign JWTs with the same secret. A key rotation for any one project requires coordinating with all the others.
- **No per-project SMTP/MFA/redirect tuning:** GoTrue env is single-tenant. IsaFlow's SMTP fix for `www513.jnb1.host-h.net` benefits every project whether they want it or not.
- **Shared `auth.users`:** all 24 IsaFlow-related users live in the shared `postgres.auth.users` table alongside FibreFlow's users, Turnitout's, etc. Cross-project enumeration is trivial for anyone with DB access.
- **Upgrade friction:** bumping GoTrue, Postgres, or Kong image tags requires convincing every project owner.

ApexGEO established the precedent on 2026-04-16 by standing up its own dedicated stack at `/home/velo/apexgeo-supabase/` on ports 7780–7786. IsaFlow should follow the same pattern.

## Goal

Move IsaFlow from the shared stack to a fully-isolated standalone stack at `/home/velo/isaflow-supabase/`, modelled on ApexGEO, with:

- Dedicated Postgres 15 container (`isaflow-supabase-db`)
- Dedicated GoTrue container (`isaflow-supabase-auth`)
- Dedicated Kong, PostgREST, Realtime, Storage, Studio, Pooler
- Fresh `JWT_SECRET` + ANON/SERVICE_ROLE keys (no key reuse across stacks)
- All data migrated with zero loss (117 tenant tables + 24 `auth.users` + `auth.identities` rows)
- Passwords preserved (pg_dump of `auth.users` retains bcrypt hashes verbatim)
- Prod-user impact ≤ one forced re-login

## Non-goals

- Moving FibreFlow, Turnitout, or any other project off the shared stack. They stay.
- Supavisor transaction-pool cutover — IsaFlow stays on direct `:7772` (same rationale as shared :5437, Supavisor expects `postgres.<tenant>` format).
- Portal auth (AR portal, AFS portal) — both have 0 rows and remain on custom JWT.
- Dropping the old IsaFlow data from the shared stack **in this session**. Archive now, drop on 2026-05-19 (30 days) via followup ticket.
- Horizontal scaling, replication, PITR improvements — out of scope for the split itself.

## Design decisions (resolved 2026-04-19 via brainstorming)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Port range | **7770–7776** | Free range below ApexGEO's 7780–7786. Mnemonic: IsaFlow is 7770s, ApexGEO is 7780s. |
| 2 | Cutover window | **Live cutover** (~60s re-login blip from JWT_SECRET rotation) | 15 active users, Sunday off-hours. No maintenance banner needed. |
| 3 | Write-freeze strategy | **Live dump — no service stop during dump** | Service stays up during `pg_dump`. Only stop for env-swap + restart (~30s). Accepted risk: writes after dump snapshot but before cutover are lost. Sunday off-hours + no 06:00 `isaflow-management-packs.timer` overlap makes this effectively zero. |
| 4 | Old data retention | **30 days** — scheduled drop 2026-05-19 | Archive-rename `isaflow` → `isaflow_archived` on shared stack. 30 days covers accounting month-end + any latent bug. Hein triggers the final drop via followup ticket. |
| 5 | Auth user migration | **pg_dump `--data-only` + pg_restore**, filtered by IsaFlow user_ids | Preserves bcrypt hashes verbatim. No password resets required. `auth.mfa_factors` has 0 rows in prod — carried anyway for completeness. |
| 6 | SMTP | **Reuse verbatim** — `SMTP_HOST=www513.jnb1.host-h.net`, `SMTP_USER=noreply@isaflow.co.za` | Relay is not per-app; no conflict with shared stack. Cert mismatch already solved on this host. |
| 7 | Next.js rewrite target | **Hardcode `/auth/v1/*` → `localhost:7770` on feature branch** | Matches current hardcoded style (`:8300`). Rollback = revert commit. Env-driven alternative rejected as unnecessary config surface. |

## Port layout (new stack)

| Service | Port (host → container) |
|---------|-------------------------|
| Kong HTTP (GoTrue/PostgREST/Storage proxy) | `7770 → 8000` |
| Kong HTTPS | `7771 → 8443` |
| Postgres direct TCP | `7772 → 5436` |
| Pooler (Supavisor transaction) | `7773 → 6543` |
| Pooler (Supavisor session) | `7774 → 5432` |
| Studio | `7775 → 3000` |
| Analytics (Logflare) | `7776 → 4000` |

Verified free via `ss -tlnp` on velo 2026-04-19.

## Secrets (regenerated for this stack)

Stored in `/home/velo/isaflow-supabase/.env` (mode 0600, owner `velo`). Never committed.

- `POSTGRES_PASSWORD` — fresh 32-char hex
- `JWT_SECRET` — fresh 40-char base64 (breaks all existing `sb-access-token` / `sb-refresh-token` cookies on first request after cutover → forced re-login)
- `ANON_KEY` / `SERVICE_ROLE_KEY` — HS256-signed with the new JWT_SECRET
- `DASHBOARD_USERNAME=isaflow`, `DASHBOARD_PASSWORD` — fresh random
- `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`, `LOGFLARE_PUBLIC_ACCESS_TOKEN`, `LOGFLARE_PRIVATE_ACCESS_TOKEN`, `S3_PROTOCOL_ACCESS_KEY_*` — fresh via `utils/generate-keys.sh`
- SMTP vars copied from current shared `/home/velo/supabase/.env` (`SMTP_HOST=www513.jnb1.host-h.net`, `SMTP_USER=noreply@isaflow.co.za`, `SMTP_PASS=<existing>`, `SMTP_PORT=465`, `SMTP_SENDER_NAME=IsaFlow`)

## Migrations to apply on the new stack

Run `bun scripts/apply-migrations.ts` with `MIGRATION_ADMIN_DATABASE_URL` pointing at the new stack. The migration runner will idempotently apply all 79 migrations (up through 355) from scratch. Critical ones for the role/RLS surface:

- 348 — RLS + auth helpers (app_user, migration_admin, auth.uid(), app.current_company_id(), tenant_isolation policies on 117 tables)
- 351 — SECURITY DEFINER helpers (recursion fix)
- 352 — platform_admin role (BYPASSRLS, LOGIN, NOINHERIT)
- 353 — users.last_login column (re-added post-349 drop)
- 355 — admin_impersonation_stash table

NOT applicable (skip): 354 drops `user_2fa` + `user_trusted_devices` which never existed on the new stack. Tracking row `354_drop_custom_2fa.sql` inserted manually post-apply to keep the ledger straight.

**Role passwords must be rotated** immediately after migration (CHANGEME placeholder in SQL):

```sql
ALTER ROLE migration_admin WITH PASSWORD '<fresh>';
ALTER ROLE platform_admin WITH PASSWORD '<fresh>';
```

Store the rotated passwords in `/home/velo/isaflow/.env.local` (`MIGRATION_ADMIN_DATABASE_URL`, `PLATFORM_ADMIN_DATABASE_URL`).

## Data migration

### Application data (isaflow, isaflow_dev DBs)

Source: shared stack `localhost:5437/isaflow` + `localhost:5437/isaflow_dev`.
Target: new stack `localhost:7772/isaflow` + `localhost:7772/isaflow_dev`.

**Freeze point (live-dump strategy):** do NOT stop `isaflow.service` during the dump. `pg_dump -Fc` takes a consistent REPEATABLE READ snapshot; the service keeps writing to the old DB during the dump, but those post-snapshot writes are lost at cutover (see Decision 3).

Service stop happens only around the env-swap + restart to force the new JWT_SECRET to take effect (~30s). Before dumping, stop the daily `isaflow-management-packs.timer` to prevent the 06:00 writer from firing mid-cutover if the window overlaps that hour.

```bash
# Dump (as postgres superuser)
PGPASSWORD=<shared-pw> pg_dump -h localhost -p 5437 -U postgres \
  -Fc -Z 9 --no-owner --no-acl isaflow > /tmp/isaflow.dump
PGPASSWORD=<shared-pw> pg_dump -h localhost -p 5437 -U postgres \
  -Fc -Z 9 --no-owner --no-acl isaflow_dev > /tmp/isaflow_dev.dump

# Restore
PGPASSWORD=<new-pw> pg_restore -h localhost -p 7772 -U postgres \
  --no-owner --role=postgres -d isaflow /tmp/isaflow.dump
PGPASSWORD=<new-pw> pg_restore -h localhost -p 7772 -U postgres \
  --no-owner --role=postgres -d isaflow_dev /tmp/isaflow_dev.dump
```

**Migrations re-run after restore:** the dump includes pre-built tables, so migrations that `CREATE TABLE IF NOT EXISTS` are no-ops. The `schema_migrations` tracking rows come across in the dump, so the ledger is already current. Migration runner will idempotently verify + skip.

**Verification:**
- `SELECT COUNT(*) FROM companies` matches source
- `SELECT COUNT(*) FROM journal_entries` matches source
- `SELECT COUNT(*) FROM users` matches source (15)
- `pg_dump --schema-only | sha256sum` roughly matches on both sides (tolerable drift for COLLATE provider)

### Auth data (auth.users + auth.identities + auth.mfa_factors)

Source: shared stack `localhost:5437/postgres.auth.*` — 24 rows filtered by IsaFlow-owned `user.id` values.
Target: new stack `localhost:7772/postgres.auth.*` (GoTrue's own DB, auto-provisioned by the `auth` container on first boot).

IsaFlow-owned user_ids: the 15 rows in `isaflow.users` plus any invited-but-not-yet-accepted rows in `auth.users` that were pre-provisioned during Phase 2. Derive via:

```sql
-- On shared stack
SELECT au.id
FROM postgres.auth.users au
WHERE au.id::text IN (SELECT id FROM isaflow.users);
```

Filtered dump:

```bash
# Dump (filter to IsaFlow IDs only — preserves bcrypt hashes)
PGPASSWORD=<shared-pw> psql -h localhost -p 5437 -U postgres postgres -c "\
  COPY (SELECT * FROM auth.users WHERE id IN (<id-list>)) TO STDOUT" \
  > /tmp/auth_users.copy
# Same for auth.identities WHERE user_id IN (<id-list>)
# Same for auth.mfa_factors WHERE user_id IN (<id-list>) — 0 rows expected
```

Restore via `COPY ... FROM STDIN` into the new stack. Verify counts before promoting.

**Critical:** password hashes in `auth.users.encrypted_password` are bcrypt strings. GoTrue checks them verbatim via `crypto/bcrypt` — no re-hashing needed. Users' existing passwords keep working.

## Cutover sequence

1. **Prep (hours before):** new stack running, migrations applied, schema verified, dry-run on `isaflow_dev` completed, feature-branch PR merged.
2. **Quiesce timers:** `sudo systemctl stop isaflow-management-packs.timer` (the only systemd timer that writes to IsaFlow DB). `signum-cron.timer` hits the Signum service, not IsaFlow DB — leave running.
3. **Dump (service still up):** `pg_dump -Fc` of `isaflow` + `isaflow_dev` from shared stack `:5437`. Takes a consistent snapshot; service keeps serving writes to the old DB during this window.
4. **Dump auth:** filtered `COPY` of `auth.users` / `auth.identities` / `auth.mfa_factors` by IsaFlow user_ids from shared `postgres` DB.
5. **Restore:** into new stack `:7772/isaflow` + `:7772/isaflow_dev` + new `postgres.auth.*`. Verify row counts match source.
6. **Back up env:** `cp /home/velo/isaflow/.env.local /home/velo/isaflow/.env.local.pre-stack-split.$(date +%s)`.
7. **Swap env:** rewrite `.env.local` to point at new stack ports + new JWT_SECRET + new keys + new role passwords.
8. **Deploy + restart:** `cd /home/velo/isaflow && git pull && bun install && bun run build && sudo systemctl restart isaflow` (the Next.js `rewrites()` change to `:7770` is already in the merged PR).
9. **Smoke:** login (admin + non-admin), 2FA status, impersonate round-trip, password reset link gen, one API read per module.
10. **Monitor:** 1 hour watching Sentry + `pg_stat_activity` on new stack + shared stack.
11. **Archive old:** `ALTER DATABASE isaflow RENAME TO isaflow_archived` on shared stack. Same for `isaflow_dev`. Do NOT delete auth rows in this session — that happens at the 30-day drop.
12. **Restart timer:** `sudo systemctl start isaflow-management-packs.timer`.

## Rollback

If the new stack misbehaves within 30 days:

1. `sudo systemctl stop isaflow`
2. Restore `/home/velo/isaflow/.env.local.pre-stack-split.<timestamp>` → `/home/velo/isaflow/.env.local`
3. `ALTER DATABASE isaflow_archived RENAME TO isaflow` on shared stack (inverse of cutover step 11)
4. Same for `isaflow_dev_archived`
5. IsaFlow rows in shared `postgres.auth.*` were NOT deleted at cutover, so nothing to re-insert
6. `cd /home/velo/isaflow && git checkout <pre-stack-split-sha> && bun run build`
7. `sudo systemctl start isaflow`
8. Users re-login against old shared-stack JWT_SECRET (which is back in `.env.local` post step 2)

Rehearsal: test rollback steps 1→7 in reverse against `isaflow_dev` before cutover.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| GoTrue first-boot config drift (MFA env toggles, SMTP cert, redirect allow-list) — all hit on the current stack | Copy env surface from shared `/home/velo/supabase/.env` verbatim, except JWT_SECRET/keys/POSTGRES_PASSWORD. `GOTRUE_MFA_TOTP_ENROLL_ENABLED=true` and `GOTRUE_MFA_TOTP_VERIFY_ENABLED=true` MUST be set explicitly (not default). |
| Kong `/auth/v1/` route map differs between fresh stack and 6-month-old shared stack | Diff `volumes/api/kong.yml` before bringing up; use shared stack's copy as source-of-truth. |
| Password hashes don't verify post-restore | Pre-cutover dry run: dump one user's auth row from shared, restore into `isaflow_dev`'s new stack, test login via `/auth/v1/token?grant_type=password` — if bcrypt check fails, fallback is manual password-reset emails via GoTrue admin `generate_link('recovery')` to all 15 users. |
| Next.js `rewrites()` change hasn't hit prod before cutover | Deploy `rewrites()` change to dev first (dev still pointed at shared stack but with the new target bound to shared Kong until cutover minute); verify. Then deploy-and-env-swap prod in one sequence. |
| `pg_stat_activity` shows unexpected connections post-cutover (e.g. dev env still pointing at shared) | Grep all `.env*` files on velo for `5437` / `8300` post-cutover; ensure only archived/rollback paths reference them. |
| `active_company_id` cookie leaks across the two secrets | It's a plain cookie (not JWT-signed); survives the swap by design. No risk — it's just a UI preference. |
| **Live-dump write-loss window** — writes committed after the `pg_dump` snapshot but before the service restart go to the old DB and are lost. | Schedule cutover for Sunday off-hours when user activity is ~0. Stop `isaflow-management-packs.timer` before dump. Time the dump-to-restart gap: target ≤ 2 minutes. Post-cutover, tail `pg_stat_activity` on shared stack to confirm zero writers. If any critical write happens in the window, the archived shared DB still has it — manual reconciliation possible during the 30-day retention window. |
| **30-day drop forgotten** — archived DBs linger on shared stack indefinitely, consuming disk and drifting out of audit | Followup task noted in memory + calendar. Hein triggers the drop. Re-verify `pg_stat_activity` is 0 at drop time. |

## Out-of-scope work deferred

- Supavisor transaction-pool cutover (requires tenant-id format work — low priority)
- AFS portal / AR portal auth migration (both have 0 rows)
- `user_sessions` table drop (follow-up ticket)
- `forceLogout` port from `user_sessions` to GoTrue `DELETE /admin/users/:id` sessions API
- Middleware-level AAL2 enforcement

## Success criteria

- [ ] `isaflow-supabase-*` containers all healthy for ≥ 1 hour
- [ ] `SELECT COUNT(*) FROM pg_stat_activity WHERE datname='isaflow'` on shared stack == 0
- [ ] `isaflow` service logs zero Postgres connection errors for 1 hour
- [ ] 15 prod users can log in (verified via smoke + Sentry error rate)
- [ ] 2FA round-trip green
- [ ] Impersonate → end-impersonate green
- [ ] Password reset link gen green
- [ ] Sentry error rate ≤ pre-cutover baseline for 24h
- [ ] No writes to shared `postgres.auth.*` table from IsaFlow service (verified via pg_stat_activity audit)
