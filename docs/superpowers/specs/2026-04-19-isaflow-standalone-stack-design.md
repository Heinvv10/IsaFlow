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
- Supavisor transaction-pool cutover — IsaFlow stays on direct `:7792` (same rationale as shared :5437, Supavisor expects `postgres.<tenant>` format).
- Portal auth (AR portal, AFS portal) — both have 0 rows and remain on custom JWT.
- Dropping the old IsaFlow data from the shared stack. Archive-and-keep for indefinite rollback.
- Horizontal scaling, replication, PITR improvements — out of scope for the split itself.

## Design decisions (resolved 2026-04-19 via brainstorming)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Port range | **7790–7796** | Free range, above ApexGEO's 7780–7786, consistent layout. |
| 2 | Cutover window | **Live cutover** (~30s service blip, forced re-login) | 15 active users; maintenance window is overkill. |
| 3 | Old data retention | **Forever — archive** | Rename `isaflow` → `isaflow_archived`, `isaflow_dev` → `isaflow_dev_archived` on shared stack. Keep as dead-cold rollback. |
| 4 | Auth user migration | **pg_dump `--data-only` + pg_restore**, filtered by IsaFlow user_ids | Preserves bcrypt hashes verbatim. No password resets required. |
| 5 | SMTP | **Reuse verbatim** — `SMTP_HOST=www513.jnb1.host-h.net`, `SMTP_USER=noreply@isaflow.co.za` | Relay is not per-app; no conflict with shared stack. |
| 6 | Next.js rewrite target | **Update `/auth/v1/*` → `localhost:7790`** | New Kong HTTP port; committed code change. |

## Port layout (new stack)

| Service | Port (host → container) |
|---------|-------------------------|
| Kong HTTP (GoTrue/PostgREST/Storage proxy) | `7790 → 8000` |
| Kong HTTPS | `7791 → 8443` |
| Postgres direct TCP | `7792 → 5436` |
| Pooler (Supavisor transaction) | `7793 → 6543` |
| Pooler (Supavisor session) | `7794 → 5432` |
| Studio | `7795 → 3000` |
| Analytics (Logflare) | `7796 → 4000` |

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
Target: new stack `localhost:7792/isaflow` + `localhost:7792/isaflow_dev`.

**Freeze point:** stop `isaflow.service` via `systemctl` before the dump. This gives us a consistent snapshot. Users will see a brief 503 from cloudflared; ~30s window.

```bash
# Dump (as postgres superuser)
PGPASSWORD=<shared-pw> pg_dump -h localhost -p 5437 -U postgres \
  -Fc -Z 9 --no-owner --no-acl isaflow > /tmp/isaflow.dump
PGPASSWORD=<shared-pw> pg_dump -h localhost -p 5437 -U postgres \
  -Fc -Z 9 --no-owner --no-acl isaflow_dev > /tmp/isaflow_dev.dump

# Restore
PGPASSWORD=<new-pw> pg_restore -h localhost -p 7792 -U postgres \
  --no-owner --role=postgres -d isaflow /tmp/isaflow.dump
PGPASSWORD=<new-pw> pg_restore -h localhost -p 7792 -U postgres \
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
Target: new stack `localhost:7792/postgres.auth.*` (GoTrue's own DB, auto-provisioned by the `auth` container on first boot).

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

1. **Prep (hours before):** new stack running, migrations applied, schema verified.
2. **Freeze:** `sudo systemctl stop isaflow` (app serves 502 via cloudflared — ~30s window).
3. **Dump:** application + auth data from shared stack.
4. **Restore:** into new stack. Verify row counts.
5. **Swap env:** back up `/home/velo/isaflow/.env.local`, rewrite to point at new stack ports + new JWT_SECRET + new keys.
6. **Deploy:** already-merged Next.js change for `/auth/v1/*` rewrite target lives in repo, so deploy.sh pulls + rebuilds.
7. **Start:** `sudo systemctl start isaflow`.
8. **Smoke:** login (admin + non-admin), 2FA enroll, impersonate round-trip, password reset link, one API read per module.
9. **Monitor:** 1 hour watching Sentry + `pg_stat_activity` on new stack.
10. **Archive old:** `ALTER DATABASE isaflow RENAME TO isaflow_archived` on shared stack. Same for `isaflow_dev`. Delete 24 rows from shared `postgres.auth.*` filtered by the same user_id list. Document the rollback anchor.

## Rollback

If the new stack misbehaves within 7 days:

1. `sudo systemctl stop isaflow`
2. Restore `/home/velo/isaflow/.env.local.pre-stack-split.<timestamp>` → `/home/velo/isaflow/.env.local`
3. `ALTER DATABASE isaflow_archived RENAME TO isaflow` on shared stack (inverse of step 10 above)
4. Same for `isaflow_dev_archived`
5. Re-insert the 24 auth rows if they were deleted (they're in `/tmp/auth_users.copy` backup)
6. `sudo systemctl start isaflow`
7. Force users to re-login (JWT_SECRET reverts to the old shared-stack secret)

Rehearsal: test rollback steps 2→6 in reverse against `isaflow_dev` before cutover.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| GoTrue first-boot config drift (MFA env toggles, SMTP cert, redirect allow-list) — all hit on the current stack | Copy env surface from shared `/home/velo/supabase/.env` verbatim, except JWT_SECRET/keys/POSTGRES_PASSWORD. `GOTRUE_MFA_TOTP_ENROLL_ENABLED=true` and `GOTRUE_MFA_TOTP_VERIFY_ENABLED=true` MUST be set explicitly (not default). |
| Kong `/auth/v1/` route map differs between fresh stack and 6-month-old shared stack | Diff `volumes/api/kong.yml` before bringing up; use shared stack's copy as source-of-truth. |
| Password hashes don't verify post-restore | Pre-cutover dry run: dump one user's auth row from shared, restore into `isaflow_dev`'s new stack, test login via `/auth/v1/token?grant_type=password` — if bcrypt check fails, fallback is manual password-reset emails via GoTrue admin `generate_link('recovery')` to all 15 users. |
| Next.js `rewrites()` change hasn't hit prod before cutover | Deploy `rewrites()` change to dev first (dev still pointed at shared stack but with the new target bound to shared Kong until cutover minute); verify. Then deploy-and-env-swap prod in one sequence. |
| `pg_stat_activity` shows unexpected connections post-cutover (e.g. dev env still pointing at shared) | Grep all `.env*` files on velo for `5437` / `8300` post-cutover; ensure only archived/rollback paths reference them. |
| `active_company_id` cookie leaks across the two secrets | It's a plain cookie (not JWT-signed); survives the swap by design. No risk — it's just a UI preference. |

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
