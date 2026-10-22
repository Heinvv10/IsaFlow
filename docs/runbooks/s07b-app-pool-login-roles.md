# Runbook: S-07b app pool login roles

Do the steps in this order, after 17:00 SAST on a weekday, with Hein's approval for each.

The PR that ships migrations 915, 916 and 917 creates the roles with no
password and no LOGIN, and every new env var falls back to `DATABASE_URL`, so
the app keeps logging in as today. These do take effect on deploy:

- POST /api/invite/[token] writes on the migration_admin pool, as
  /api/invitations/[token]/accept already did. In production the app now
  refuses to boot without `MIGRATION_ADMIN_DATABASE_URL` (prod has it).
- app_user can no longer write `schema_migrations` (917).
- The views `clients` and `app_settings` run as the caller (917,
  `security_invoker`): each request sees only its own company's rows through
  them. Some readers filtered by key only (drc-vat-export, budget exports,
  pdfShared) and could read another tenant's row before; a "missing setting"
  report after deploy is this, not a regression.
- Three definer functions get `pg_temp` last on their search path (917).
- The member guards bind app_service holders (916). Nothing logs in as one
  yet, so no request changes.
- Every migration run (deploy, parity gate on dev, `bun run db:migrate`) ends
  with `SELECT public.app_service_sync_policies()`, which adds app_service's
  policies for any table a migration added.
- `scripts/verify-deploy.sh` gains step 4: `scripts/check-app-login-roles.ts`
  runs `public.app_login_role_violations()` as the owner and fails the
  verification on any row. Once either login can log in (step 3 below) it
  also requires the event trigger (step 2) and the reserved roles (step 3b).
- Every boot in production writes `[env] S-07b: the request pool logs in as
  "postgres", not isaflow_app` to stderr until step 5 is done.

## 0. Before you start

- Prod and dev share one PostgreSQL 15.8 cluster (`isaflow-supabase`, port 7772).
  Roles are cluster-wide, so 915 creates `isaflow_app`, `isaflow_service` and
  `app_service` for every database the first time it runs anywhere. The first
  run is normally the deploy's parity gate applying it to `isaflow_dev`.
- The prod env file is `/home/velo/isaflow/.env.local` (velo:velo 0600). You
  edit it as velo, or with sudo.

## 0b. Read-only pre-check (as the owner, on `isaflow`)

Each query must return zero rows; any row is a migration that would refuse
mid-deploy, after the migrations before it have applied:

```sql
-- 917: settings rows with no company
SELECT count(*) FROM accounting_settings WHERE company_id IS NULL HAVING count(*) > 0;
-- 917: views owned by an RLS-bypassing role that app_user can use, without security_invoker
SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles o ON o.oid = c.relowner
 WHERE c.relkind = 'v' AND n.nspname IN ('public','auth','app','platform_shared')
   AND (o.rolsuper OR o.rolbypassrls)
   AND has_table_privilege('app_user', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
   AND c.oid::regclass::text NOT IN ('clients', 'app_settings')
   AND NOT coalesce(c.reloptions && ARRAY['security_invoker=true','security_invoker=on','security_invoker=1'], false);
-- 917: app_user-executable definer functions without pg_temp last (917 fixes these three only)
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef AND n.nspname IN ('public','auth','app','platform_shared')
   AND has_function_privilege('app_user', p.oid, 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c ~ '^search_path=.*pg_temp"?$')
   AND p.oid::regprocedure::text NOT IN ('auth.user_admin_companies(text)', 'auth.set_default_company(uuid,uuid)', 'invite_token_company_name()');
-- 916: each guard must hold the old exemption line exactly once
SELECT proname, hits FROM (
  SELECT proname, prosrc, (length(prosrc) - length(replace(prosrc, l, ''))) / length(l) AS hits
    FROM pg_proc, (VALUES ($$IF current_user <> 'app_user' THEN$$)) v(l)
   WHERE proname IN ('company_users_role_guard', 'company_invitations_role_guard')) g
 WHERE prosrc !~ 'pg_has_role\(current_user' AND hits <> 1;
```

## 1. Deploy the code (migrations 915, 916 and 917 included)

915 refuses to apply if a role either app login can reach owns an object in ANY
database of the cluster (pg_shdepend). It fails safe, and the parity gate meets
it on dev first. If it fires, the message names the role: reassign that
object's ownership, do not weaken the check.

`bash scripts/deploy.sh`, from a clean worktree at master.

The deploy logs a `WARNING: OWNER_DATABASE_URL is not set` line. That is expected
at this step: the deploy falls back to `DATABASE_URL`, which is still `postgres`.

Verify:
```sql
SELECT rolname, rolcanlogin, rolinherit, rolbypassrls FROM pg_roles
 WHERE rolname IN ('isaflow_app','isaflow_service','app_service');
-- 3 rows, rolcanlogin = false, rolbypassrls = false; isaflow_app rolinherit = false
SELECT count(*) FROM pg_policy WHERE polname LIKE 'app\_service\_%';   -- > 200, in isaflow
SELECT has_table_privilege('app_user', 'schema_migrations', 'DELETE');  -- false (917)
SELECT * FROM public.app_login_role_violations(false);                  -- no rows
```

## 2. Refuse DDL from the app logins (once per cluster, as `supabase_admin`)

The Supabase image preloads `supautils`. supautils lets ANY login run CREATE
EXTENSION for its `privileged_extensions` list (dblink, postgres_fdw, pg_net,
http, pgsodium, pg_graphql, postgis, pg_tle, plv8, ...). It installs them as
`supabase_admin`, whatever the caller's database privileges. Several of these
then hand the caller EXECUTE on supabase_admin-owned SECURITY DEFINER functions,
and pg_net/http give the database an outbound network channel. Today's
`postgres` login can do the same, so this predates S-07b. But it is the one
route by which isaflow_app / isaflow_service could get objects created as a
superuser (S-07b breaker round 2, N1, verified on supabase/postgres:15.8.1.085).

The app runs no DDL at runtime (checked: no CREATE/ALTER/DROP/TRUNCATE in
src/ or pages/), except the AR cron's REFRESH MATERIALIZED VIEW. That runs
inside an owner-run definer function, which the trigger lets through.
Verified on supabase/postgres:15.8.1.085: both logins are refused CREATE
EXTENSION dblink and pgsodium (as supabase_admin), CREATE TEMP TABLE (as
themselves and as app_user) and ALTER TABLE. postgres can still CREATE
EXTENSION. The refresh wrapper works, and the s07b attack and path suites pass. So refuse all DDL from the two app logins. Only a superuser
can create an event trigger, so run this as `supabase_admin` in each database
the app uses (`isaflow`, and `isaflow_dev` if dev moves to the new logins):

```sql
CREATE OR REPLACE FUNCTION public.refuse_app_pool_ddl() RETURNS event_trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Judged on the EFFECTIVE role. An app login running as itself, as
  -- app_user/app_service, or as a superuser (supautils runs a privileged
  -- CREATE EXTENSION as supabase_admin) is refused. A SECURITY DEFINER
  -- function owned by the non-superuser postgres is let through: the AR
  -- cron's refresh_customer_invoice_view_summary() (915) runs REFRESH ...
  -- CONCURRENTLY, which creates a temp table internally. This relies on prod's
  -- postgres being NOSUPERUSER (it is: rolsuper = f).
  IF session_user IN ('isaflow_app', 'isaflow_service')
     AND (current_user IN ('isaflow_app', 'isaflow_service', 'app_user', 'app_service')
          OR (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)) THEN
    RAISE EXCEPTION 'DDL (%) refused for % (as %)', tg_tag, session_user, current_user USING ERRCODE = '42501';
  END IF;
END $$;
CREATE EVENT TRIGGER refuse_app_pool_ddl ON ddl_command_start
  EXECUTE FUNCTION public.refuse_app_pool_ddl();
```

Verify it after step 3 (the logins need a password first). As each login, in
`isaflow`:
```sql
BEGIN; CREATE EXTENSION dblink;   -- expect ERROR 42501 "DDL (CREATE EXTENSION) refused for isaflow_app (as supabase_admin)"
ROLLBACK;
```
As `postgres`, a CREATE EXTENSION inside BEGIN ... ROLLBACK must still succeed:
the deploy's migrations run as postgres. And the AR cron must still answer 200:
`curl -X POST -H "X-Cron-Secret: $CRON_SECRET" http://127.0.0.1:3101/api/cron/ar-matview-refresh`.

Separate ops item (not S-07b, pre-existing): on this image,
`GRANT <role> TO PUBLIC` or `GRANT <role> TO current_user` from any login
crashes the backend with SIGSEGV (supautils), and the whole cluster restarts.
Raise it with Supabase, or pin a fixed image.

## 3. Enable the logins (once per cluster)

Run as `postgres`. Generate the passwords with
`openssl rand -base64 33 | tr -d '/+='` and store them in `~/.secrets`.
Do not put them on a command line: use `psql` and `\password`, or `-v` from a
0600 file.

```sql
ALTER ROLE isaflow_app     LOGIN PASSWORD '<app password>';
ALTER ROLE isaflow_service LOGIN PASSWORD '<service password>';
```

Check that pg_hba lets both roles in from the app host, the same way it lets
`postgres` in, using the Supavisor/pooler user format if the URL goes through
the pooler:
```bash
psql "postgresql://isaflow_app:<pw>@100.96.203.105:7772/isaflow" -c 'select current_user'
```

## 3b. Make the two logins reserved roles (once per cluster, after step 3)

Any role may change its own password and its own session defaults, and the
event trigger does not see ALTER ROLE. One injected statement could therefore
run `ALTER ROLE isaflow_service SET default_transaction_read_only = on`, a
read-only app that survives restarts, or change the login's password (S-07b
verifier, P2). supautils refuses every change to a reserved role that does
not come from a superuser:

1. In the IsaFlow Supabase db container, append the two logins to
   `supautils.reserved_roles` in `/etc/postgresql-custom/supautils.conf`:
   `..., anon*, isaflow_app, isaflow_service'`. Check first that the file is
   on a mounted volume (`docker inspect`), or the change is lost when the
   container is recreated.
2. As supabase_admin: `SELECT pg_reload_conf();`

Verify, as isaflow_service:
`ALTER ROLE isaflow_service SET statement_timeout = 1;` must fail with
`"isaflow_service" is a reserved role, only superusers can modify it`.

From then on, rotate either password as supabase_admin, not as postgres.
Migration 915 changes the roles only when they differ from what it expects, so
re-running it, or applying it to another database of the cluster, still works
(verified on supabase/postgres:15.8.1.085 with non-superuser postgres).

## 4. Reinstall the backup scripts (before the env change)

The backup and restore-drill units run root-owned copies in `/opt/isaflow-ops`.
Those copies read `DATABASE_URL`, which step 5 turns into `isaflow_app`, and
pg_dump would fail as that role. Reinstall the copies first, so they read
`OWNER_DATABASE_URL` (and fall back to `DATABASE_URL`, still `postgres`, until
step 5), leaving no window in which a backup or WAL archive runs on the old
copies with the new env:

`sudo bash scripts/ops/install-backup-ops.sh` (it installs `ownerDatabaseUrl.sh` beside `lib-pgconn.sh`)

Then check: `sudo grep -c OWNER_DATABASE_URL /opt/isaflow-ops/lib-pgconn.sh` (expect ≥ 1).

## 5. Change the prod env (`/home/velo/isaflow/.env.local`)

Keep a copy first: `sudo cp -p .env.local .env.local.pre-s07b`.

```
OWNER_DATABASE_URL=<the current DATABASE_URL value, unchanged (postgres)>
SERVICE_DATABASE_URL=postgresql://isaflow_service:<pw>@<same host:port>/isaflow?<same params>
DATABASE_URL=postgresql://isaflow_app:<pw>@<same host:port>/isaflow?<same params>
```

Leave `PLATFORM_ADMIN_DATABASE_URL` and `MIGRATION_ADMIN_DATABASE_URL` as they are.
The app refuses to boot if `DATABASE_URL` names isaflow_app while
`SERVICE_DATABASE_URL` is unset (validateEnv), so set all three together.

`OWNER_DATABASE_URL` now sits in the app's own env file, so the app process
holds the owner's credentials although no app code reads them. An injected SQL
statement cannot read the process environment; code execution in the app
could, as it could read `DATABASE_URL` (the owner) today. Moving the owner URL
to a file only the deploy and backup scripts read is a follow-up, not part of
this change.

## 6. Restart and verify

`sudo systemctl restart isaflow`. Then:

- `journalctl -u isaflow --since -2min` shows no `permission denied` and no
  `row-level security` errors.
- In the database, `SELECT usename, count(*) FROM pg_stat_activity WHERE datname = 'isaflow' GROUP BY 1`
  shows connections from isaflow_app and isaflow_service, and none from
  `postgres` belonging to the app.
- Log in, open a company, list invoices, and save a profile change (withAuth).
- Open `/api/auth/me` (service).
- Read an admin page (the platform-admin gate runs on isaflow_app).
- Fire one cron by hand:
  `curl -X POST -H "X-Cron-Secret: $CRON_SECRET" http://127.0.0.1:3101/api/cron/ar-matview-refresh`.
- Bugsink shows no new `42501` / `permission denied` issues for 30 minutes.

## Rollback (instant, no code change)

1. Restore `.env.local.pre-s07b`.
2. `sudo systemctl restart isaflow`.

**Env first, then code.** Never run `scripts/rollback-deploy.sh` to a release
older than this PR while the env still names `isaflow_app`: the old code
ignores `SERVICE_DATABASE_URL` and has no boot check, so every cron, login and
public route would fail with 42501, and its `deploy.sh` would migrate as
`isaflow_app`. Restore the env and restart first; roll the code back after.

A post-deploy verification failure auto-runs `rollback-deploy.sh`. Once the
logins can log in, step 4 of that verification fails if the event trigger or
the reserved roles are missing, so finish steps 2 and 3b before the next
deploy.

The roles and policies can stay; nothing uses them. To remove the logins as well:
`ALTER ROLE isaflow_app NOLOGIN; ALTER ROLE isaflow_service NOLOGIN;`.

## Dev (optional, after prod is stable)

Dev's workspace `.env.local` can follow the same three-variable pattern against
`isaflow_dev`. The deploy's parity gate reads dev's `OWNER_DATABASE_URL` too.
