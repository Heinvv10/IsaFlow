# IsaFlow Standalone Supabase Stack — Implementation Plan

**Date:** 2026-04-19
**Spec:** [2026-04-19-isaflow-standalone-stack-design.md](../specs/2026-04-19-isaflow-standalone-stack-design.md)
**Branch:** `infra/isaflow-standalone-stack`
**Target duration:** 1 day with proper gates
**Cutover gate:** after-hours (outside 08:00–17:00 SAST Mon–Fri) OR Sunday, with Hein's explicit go-ahead

## Pre-flight

- [ ] P0. Spec reviewed + merged to master
- [ ] P1. Feature branch `infra/isaflow-standalone-stack` created off master
- [ ] P2. `bunx tsc --noEmit` clean on current master before starting
- [ ] P3. Rollback anchor tag candidate identified (`v-pre-stack-split` → will tag master at merge time)

## Task 1 — Provision new stack directory

**Goal:** Clone ApexGEO's stack as the template; adjust for IsaFlow ports and naming.

- [ ] 1.1. On velo: `sudo -u velo cp -r /home/velo/apexgeo-supabase /home/velo/isaflow-supabase`
- [ ] 1.2. Wipe volumes: `rm -rf /home/velo/isaflow-supabase/volumes/db/data /home/velo/isaflow-supabase/volumes/storage/*` (keep init scripts)
- [ ] 1.3. Rename all `apexgeo-supabase-*` container names in `docker-compose.yml` → `isaflow-supabase-*`
- [ ] 1.4. Rename network `apexgeo_network` → `isaflow_network`
- [ ] 1.5. Generate fresh secrets via `bash utils/generate-keys.sh` → replace `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `POSTGRES_PASSWORD`, `DASHBOARD_PASSWORD`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`, `LOGFLARE_*_TOKEN`, `S3_PROTOCOL_ACCESS_KEY_*` in `.env`
- [ ] 1.6. Set ports in `.env`: `KONG_HTTP_PORT=7770`, `KONG_HTTPS_PORT=7771`, `POSTGRES_PORT_HOST=7772`, `POOLER_PROXY_PORT_TRANSACTION=7773`, `POOLER_PROXY_PORT_SESSION=7774`, `STUDIO_PORT=7775`, `ANALYTICS_PORT=7776`
- [ ] 1.7. Set IsaFlow-specific env: `POSTGRES_DB=postgres` (GoTrue requires this, NOT `isaflow`), `POOLER_TENANT_ID=isaflow`, `STUDIO_DEFAULT_ORGANIZATION=IsaFlow`, `STUDIO_DEFAULT_PROJECT=IsaFlow`, `SITE_URL=https://app.isaflow.co.za`, `ADDITIONAL_REDIRECT_URLS=https://app.isaflow.co.za/*`, `SUPABASE_PUBLIC_URL=http://100.96.203.105:7770`, `API_EXTERNAL_URL=http://100.96.203.105:7770`, `DASHBOARD_USERNAME=isaflow`
- [ ] 1.8. Copy SMTP config verbatim from shared `/home/velo/supabase/.env`: `SMTP_HOST=www513.jnb1.host-h.net`, `SMTP_PORT=465`, `SMTP_USER=noreply@isaflow.co.za`, `SMTP_PASS=<from-shared>`, `SMTP_SENDER_NAME=IsaFlow`, `SMTP_ADMIN_EMAIL=hein@h10.co.za`
- [ ] 1.9. Enable MFA: add `MFA_TOTP_ENROLL_ENABLED=true`, `MFA_TOTP_VERIFY_ENABLED=true` to `.env`. Uncomment the matching `GOTRUE_MFA_*` env block in `docker-compose.yml`
- [ ] 1.10. Diff `volumes/api/kong.yml` against `/home/velo/supabase/volumes/api/kong.yml`; adopt shared-stack kong.yml if it diverges

**Verification:** `docker compose -f /home/velo/isaflow-supabase/docker-compose.yml config` parses without errors.

## Task 2 — Start new stack

- [ ] 2.1. `cd /home/velo/isaflow-supabase && sudo -u velo docker compose up -d`
- [ ] 2.2. Watch logs: `docker compose logs -f --tail=100` — wait for `isaflow-supabase-db` healthy, then `isaflow-supabase-auth` healthy, then `isaflow-supabase-kong` healthy
- [ ] 2.3. Verify all ports listening: `ss -tlnp | grep -E ':777[0-6]'` (expect 7770, 7771, 7772, 7773, 7774, 7775, 7776)
- [ ] 2.4. Smoke GoTrue: `curl -sS http://localhost:7770/auth/v1/settings -H "apikey: $ANON_KEY" | jq .external.email` → expect `true`
- [ ] 2.5. Smoke Postgres: `PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -p 7772 -U postgres postgres -c 'SELECT version()'` → PG 15

**Verification:** 17 containers up, all healthy, all 7 ports listening, GoTrue settings endpoint responds.

## Task 3 — Provision IsaFlow databases + roles + schema

**Goal:** Create `isaflow` + `isaflow_dev` databases on the new stack, run migrations from scratch. Validates the stack before we touch production data.

- [ ] 3.1. `CREATE DATABASE isaflow OWNER postgres; CREATE DATABASE isaflow_dev OWNER postgres;` on new stack
- [ ] 3.2. Temp set `MIGRATION_ADMIN_DATABASE_URL=postgresql://postgres:$POSTGRES_PASSWORD@localhost:7772/isaflow_dev?sslmode=disable` in a scratch env file
- [ ] 3.3. Run `bun scripts/apply-migrations.ts` against `isaflow_dev` — all 79 migrations should apply (skipping 354 manually)
- [ ] 3.4. Rotate role passwords on new stack:
  ```sql
  ALTER ROLE migration_admin WITH PASSWORD '<fresh>';
  ALTER ROLE platform_admin WITH PASSWORD '<fresh>';
  ```
  Record in scratch location for Task 8.
- [ ] 3.5. Grant verification: `SELECT COUNT(*) FROM information_schema.role_table_grants WHERE grantee='platform_admin' AND table_schema='public'` → expect ~170 (matches Phase 3a count)
- [ ] 3.6. RLS verification: `SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity=true` → expect 117
- [ ] 3.7. Repeat 3.2–3.6 against `isaflow` DB (empty but schema-complete)

**Verification:** migration ledger shows all rows, grants + RLS counts match Phase 3a baseline.

## Task 4 — Dry-run cutover against isaflow_dev

**Goal:** prove the end-to-end dump/restore/swap flow works on dev before touching prod.

- [ ] 4.1. Dump shared `isaflow_dev`: `pg_dump -Fc -Z 9 --no-owner --no-acl` from `localhost:5437/isaflow_dev` → `/tmp/isaflow_dev.dump`
- [ ] 4.2. Truncate new stack's `isaflow_dev` (schema-only, data empty post-migration): `psql ... -c "SELECT 'TRUNCATE TABLE ' || quote_ident(schemaname) || '.' || quote_ident(tablename) || ' CASCADE;' FROM pg_tables WHERE schemaname='public'" | psql ...`. Alternatively: `DROP DATABASE isaflow_dev; CREATE DATABASE isaflow_dev;` and restore fresh.
- [ ] 4.3. Restore: `pg_restore -h localhost -p 7772 -U postgres --no-owner --role=postgres -d isaflow_dev /tmp/isaflow_dev.dump`
- [ ] 4.4. Row count comparison script: list every `public.*` table, `SELECT COUNT(*)` from shared vs new. All must match.
- [ ] 4.5. Dump + restore IsaFlow-filtered auth rows from shared `postgres.auth.*` into new stack's `postgres.auth.*` (filter by `isaflow_dev.users.id`). Verify count.
- [ ] 4.6. Test login: `curl -X POST http://localhost:7770/auth/v1/token?grant_type=password -H "apikey: $ANON_KEY" -d '{"email":"<test>","password":"<test>"}'` → expect 200 + access_token. This proves bcrypt hashes survived the transport.
- [ ] 4.7. Write a scratch `.env.isaflow-dev-standalone` for the dev environment and start a local Next.js pointing at new stack; verify API reads + writes work end-to-end.

**Verification:** dev works against new stack. If step 4.6 fails, stop — fallback to password-reset email plan.

## Task 5 — Update committed code

All of these land on branch `infra/isaflow-standalone-stack`:

- [ ] 5.1. `next.config.js`: change `/auth/v1/:path*` rewrite destination from `http://localhost:8300/auth/v1/:path*` to `http://localhost:7770/auth/v1/:path*`
- [ ] 5.2. `bunx tsc --noEmit` clean
- [ ] 5.3. `bun run test:unit` clean
- [ ] 5.4. If any integration tests hard-code `:8300` or `:5437`, parameterize via env and update
- [ ] 5.5. Commit: `feat(infra): point /auth/v1/* rewrite at new IsaFlow Kong port 7770`
- [ ] 5.6. Open PR early (draft) so CI runs on it before cutover

**Verification:** CI green on draft PR.

## Task 6 — Prod cutover (GATED — Hein explicit go-ahead, after hours or Sunday)

**Pre-gate checklist:**
- [ ] Dry-run on dev (Task 4) passed
- [ ] PR is mergeable (CI green)
- [ ] Current time is outside 08:00–17:00 SAST Mon–Fri, OR it's Sunday
- [ ] Hein has given explicit go-ahead in-session
- [ ] `/home/velo/isaflow/.env.local` is backed up to `.env.pre-stack-split.<timestamp>`

**Execution (live-dump strategy — service stays up during pg_dump; only stops for env-swap):**
- [ ] 6.1. Stop the scheduled writer timer to prevent mid-dump cron writes: `sudo systemctl stop isaflow-management-packs.timer`
- [ ] 6.2. Dump prod (service still up): `pg_dump -Fc -Z 9 --no-owner --no-acl` from `localhost:5437/isaflow` → `/tmp/isaflow-prod-$(date +%s).dump`. `pg_dump` uses REPEATABLE READ snapshot; writes during the dump continue but won't make it into the snapshot — that's the accepted risk (Sunday off-hours, 15 users, ~2-5min dump window).
- [ ] 6.3. Dump auth rows: `COPY (SELECT * FROM auth.users WHERE id IN (<15-prod-ids>))` → `/tmp/auth_users.copy`; same for `auth.identities` + `auth.mfa_factors`
- [ ] 6.4. Restore into new stack's `isaflow` DB. Verify row counts.
- [ ] 6.5. COPY auth rows into new stack's `postgres.auth.*`. Verify count = 15+.
- [ ] 6.6. **Now** stop service for env swap: `sudo systemctl stop isaflow` (cloudflared → 502; ~30s window begins)
- [ ] 6.7. Rewrite `/home/velo/isaflow/.env.local`:
  - `DATABASE_URL=postgresql://postgres:<new-pw>@localhost:7772/isaflow?sslmode=disable`
  - `JWT_SECRET=<new>`
  - `SUPABASE_ANON_KEY=<new>`
  - `SUPABASE_SERVICE_ROLE_KEY=<new>`
  - `GOTRUE_URL=http://100.96.203.105:7770/auth/v1`
  - `MIGRATION_ADMIN_DATABASE_URL=postgresql://migration_admin:<new-pw>@localhost:7772/isaflow?sslmode=disable`
  - `PLATFORM_ADMIN_DATABASE_URL=postgresql://platform_admin:<new-pw>@localhost:7772/isaflow?sslmode=disable`
  - All other vars (SMTP, Sentry, Signum, SIGNUM_*, COOKIE_DOMAIN, etc.) unchanged
- [ ] 6.8. Merge PR (use `--squash`). Push tag `v-pre-stack-split` to previous master HEAD. Fast-forward master.
- [ ] 6.9. On velo: `cd /home/velo/isaflow && git pull && bun install && bun run build`
- [ ] 6.10. `sudo systemctl start isaflow`
- [ ] 6.11. Watch logs: `journalctl -u isaflow -f` — expect clean startup, first request from cloudflared arriving within seconds
- [ ] 6.12. Re-start timer: `sudo systemctl start isaflow-management-packs.timer`

**Verification:** service up, `curl https://app.isaflow.co.za/api/health` 200.

## Task 7 — Smoke test in production

- [ ] 7.1. Login as admin at `https://app.isaflow.co.za/login` → expect re-prompt (old cookies invalidated) → success
- [ ] 7.2. Navigate to dashboard → no errors
- [ ] 7.3. 2FA status: check `/my-account/2fa` → status reads correctly
- [ ] 7.4. Impersonate a target user → JWT sub matches target → `/api/auth/me` returns target
- [ ] 7.5. End impersonation → JWT sub back to admin
- [ ] 7.6. Admin password-reset flow: `POST /api/admin/users/:id/reset-password` → returns `{reset_link: '...'}`
- [ ] 7.7. Read one record from each major module: trial balance, AR invoice list, bank reconciliation, AFS draft list
- [ ] 7.8. Write one record (throwaway): create + delete a test journal entry → AR audit log shows both rows
- [ ] 7.9. `SELECT * FROM pg_stat_activity WHERE datname='isaflow'` on new stack → expect connections from `postgres` and `platform_admin`; zero from shared stack on the old DB

**Verification:** all 9 steps pass.

## Task 8 — 1-hour monitoring window

- [ ] 8.1. Watch Sentry dashboard for IsaFlow project — expect no new error classes
- [ ] 8.2. Check `admin_audit_log` on new stack for fresh rows (login events, any admin actions)
- [ ] 8.3. `journalctl -u isaflow --since '10 minutes ago' | grep -iE 'error|fatal|panic'` → expect zero
- [ ] 8.4. Telegram notification: "IsaFlow standalone stack cutover complete — monitoring" (optional, via existing telegram MCP)
- [ ] 8.5. Confirm with Hein: "monitoring clean for 1 hour — ready to archive old data?"

## Task 9 — Archive old data (shared stack) — 30-day retention

- [ ] 9.1. On shared stack as superuser: `ALTER DATABASE isaflow RENAME TO isaflow_archived;`
- [ ] 9.2. Same: `ALTER DATABASE isaflow_dev RENAME TO isaflow_dev_archived;`
- [ ] 9.3. Delete IsaFlow rows from shared auth (backup first): `pg_dump --table=auth.users --table=auth.identities --table=auth.mfa_factors --data-only postgres > /tmp/shared-auth-backup-$(date +%s).sql`; then `DELETE FROM auth.mfa_factors WHERE user_id IN (<15-ids>); DELETE FROM auth.identities WHERE user_id IN (<15-ids>); DELETE FROM auth.users WHERE id IN (<15-ids>);`
- [ ] 9.4. Verify shared stack: `SELECT COUNT(*) FROM pg_stat_activity WHERE datname LIKE 'isaflow%'` → expect 0 (nothing connecting to the archived DBs)
- [ ] 9.5. Verify new stack: `SELECT COUNT(*) FROM auth.users` → expect 15+
- [ ] 9.6. Archived DBs kept for 30 days. Followup ticket created for 2026-05-19: `DROP DATABASE isaflow_archived; DROP DATABASE isaflow_dev_archived;` on shared stack — Hein triggers manually.

## Task 10 — Memory update + followup ticket

- [ ] 10.1. Append cutover summary to `~/.claude/projects/-home-hein-Workspace-IsaFlow/memory/project_supabase_cutover.md` under new section "## Phase 4 — standalone stack split"
- [ ] 10.2. Update `project_velo_supabase_infra.md` — add new entry for `/home/velo/isaflow-supabase/` at ports 7770–7776, note that IsaFlow is no longer on shared stack
- [ ] 10.3. Create followup note (plain text file in memory): 7-day sanity-check reminder + note that archived DBs can be dropped by Hein anytime post-cutover
- [ ] 10.4. Do NOT drop the archived DBs in this session — Hein triggers that separately

## Rollback procedure (if any step 6–8 fails)

**Fast path (< 5 min):**
1. `sudo systemctl stop isaflow`
2. `cp /home/velo/isaflow/.env.pre-stack-split.<timestamp> /home/velo/isaflow/.env.local`
3. `cd /home/velo/isaflow && git checkout <prev-master-sha> && bun run build`
4. `sudo systemctl start isaflow`
5. Old data still in shared stack → users re-login against old JWT_SECRET and everything works as before.
6. Leave new stack running + containers paused for post-mortem.

**Deep rollback (if Task 9 already ran):**
- `ALTER DATABASE isaflow_archived RENAME TO isaflow;` on shared stack
- Re-INSERT 15 auth rows from `/tmp/shared-auth-backup-*.sql`
- Above fast-path steps 2–4

## Gates summary

| Gate | When | Who |
|------|------|-----|
| Spec approval | Before Task 1 | Hein (done via brainstorming) |
| Dry-run pass | End of Task 4 | Auto-verified + Hein confirm |
| PR merge | End of Task 5 | CI green + Hein approve PR |
| Cutover go-ahead | Before Task 6.1 | Hein explicit, after-hours |
| Archive go-ahead | End of Task 8 | Hein explicit after 1h monitoring |

## Out-of-scope followups (don't touch in this PR)

- Drop `user_sessions` table (Phase 3 follow-up)
- Port `forceLogout` from `user_sessions` to GoTrue admin sessions API
- Supavisor tenant-id format work to unlock :6543 transaction pool
- Drop archived DBs from shared stack (Hein triggers separately)
- Migrate AR/AFS portal auth off custom JWT (0 rows today)
