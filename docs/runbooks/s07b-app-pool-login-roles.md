# Runbook: S-07b app pool login roles

Do the steps in this order, after 17:00 SAST on a weekday, with Hein's approval for each.

The PR that ships migrations 915, 915b, 916 and 917 creates the roles with no
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
  with `SELECT public.app_service_sync_policies()`, which makes app_service's
  policies match app_user's: it adds them for a table a migration added and
  drops them where a migration dropped or narrowed the policy they mirror.
- app_service's policies are the sync's alone. It drops a mirror whose source
  app_user policy is gone, and a hand-made policy that applies to app_service
  (any other name or shape) is reported by the deploy check below, which then
  stops the deploy until a person removes it. Give a service path access by
  an app_user policy, never by a policy for app_service.
- `scripts/deploy.sh`, right after the migrations and the drift audit and
  before the code switch, runs `scripts/check-app-login-roles.ts`:
  `public.app_login_role_violations()` as the owner. Any row stops the deploy
  there, with the old code still serving (no rollback runs; the migrations
  have applied, as when a migration fails). Once either login can log in
  (step 3 below) it also requires the event trigger (step 2) and the reserved
  roles (step 3b).
- Every boot in production writes `[env] S-07b: the request pool logs in as
  "postgres", not isaflow_app` to stderr until step 5 is done.

The follow-up PR (migrations 918 and 919, 2026-10-23) also takes effect on deploy:

- change-email, the POPIA erasure and the signup verification tokens
  (register, verify-email) run on the migration_admin pool, and app_service
  loses `UPDATE (email, updated_at)` on `users` and every grant on
  `auth_email_verification_tokens` (918), whose payload email verify-email
  writes into `users`. That
  closes 915's documented residual (a service-pool injection could rewrite any
  user's email). change-email now writes the profile first and calls GoTrue
  second: a GoTrue refusal leaves both emails as they were, a missing profile
  row answers 404, and an address another profile holds answers 409 before
  GoTrue is asked.
- The AR "last viewed" materialized view is renamed
  `customer_invoice_view_summary_mv` and no app role may read it (919). The old
  name is now a `security_invoker` view over
  `current_company_invoice_view_summary()`, which returns only the request's
  company, so the AR list, export and invoice-views drawer work unchanged, in
  the new code and in the old (during the deploy window and after a code-only
  rollback). 920 makes "no app login reaches `users.email` or a materialized
  view" a deploy check: `scripts/check-app-login-roles.ts` refuses the code
  switch on either from then on.
- `drc-vat-export` reads only its own company's `vat_rate`, and a failed read
  answers 500 instead of being swallowed.
- The deploy and the backup scripts read the owner URL from
  `/etc/isaflow/owner.env` first (step 5). Until that file exists they read
  `.env.local` as before, with a warning.

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
-- 915b: a relation granted to PUBLIC, which every login holds after RESET ROLE
SELECT n.nspname || '.' || c.relname, a.privilege_type
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
 WHERE a.grantee = 0 AND n.nspname NOT IN ('pg_catalog', 'information_schema');
-- 915b: app_user (the one existing role in either login's reach) superuser,
-- BYPASSRLS, CREATEROLE or REPLICATION, or owning anything in the cluster
SELECT rolname FROM pg_roles WHERE rolname = 'app_user'
   AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolreplication
        OR EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
                     AND refobjid = pg_roles.oid AND deptype = 'o'));
-- 915b: app_user may SET ROLE to another role (it must reach nothing)
SELECT r.rolname FROM pg_roles r
 WHERE pg_has_role('app_user', r.oid, 'MEMBER') AND r.rolname <> 'app_user';
-- 918: app_user (or PUBLIC) must not be able to write users.email. app_service
-- does not exist yet: 915 creates it and grants it the column, 918 revokes it.
SELECT 'app_user' WHERE has_column_privilege('app_user', 'public.users', 'email', 'UPDATE');
-- 920: materialized views other than the AR view summary that app_user can read
SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'm' AND n.nspname IN ('public','auth','app','platform_shared')
   AND has_any_column_privilege('app_user', c.oid, 'SELECT')
   AND c.oid::regclass::text <> 'customer_invoice_view_summary';
-- 916: each guard must hold the old exemption line exactly once
SELECT proname, hits FROM (
  SELECT proname, prosrc, (length(prosrc) - length(replace(prosrc, l, ''))) / length(l) AS hits
    FROM pg_proc, (VALUES ($$IF current_user <> 'app_user' THEN$$)) v(l)
   WHERE proname IN ('company_users_role_guard', 'company_invitations_role_guard')) g
 WHERE prosrc !~ 'pg_has_role\(current_user' AND hits <> 1;
```

## 1. Deploy the code (migrations 915-920 included)

915b refuses to apply if a role either app login can reach owns an object in ANY
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
Repro, affected tags and mitigation: `docs/runbooks/supautils-grant-public-segfault.md`.

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

Then check: `sudo grep -c owner_database_url_for /opt/isaflow-ops/lib-pgconn.sh` (expect ≥ 1).

## 5. Move the owner URL out of the app's env, then change the prod env

The app runs as `velo` with `EnvironmentFile=/home/velo/isaflow/.env.local`,
so anything in that file is in the app process's environment. The owner URL
goes in its own file instead, which only the deploy (through `sudo`) and the
root-run backup scripts read: `/etc/isaflow/owner.env`, `root:root 0600`.
It is outside `/home/velo/isaflow`, which every deploy `rsync --delete`s
(only `.env.local` and its backup patterns survive there), and outside the
rollback snapshot. `scripts/ops/ownerDatabaseUrl.sh` reads it first, then
`.env.local`'s `OWNER_DATABASE_URL` (warning that the app loads it), then
`.env.local`'s `DATABASE_URL` (warning that it is not set).

5a. Create the owner file with today's `DATABASE_URL` value (still `postgres`).
The value is copied file to file, never printed or put on a command line:

```bash
sudo install -d -o root -g root -m 0700 /etc/isaflow
sudo sh -c 'umask 077; grep -E "^DATABASE_URL=" /home/velo/isaflow/.env.local | head -1 \
  | sed "s/^DATABASE_URL=/OWNER_DATABASE_URL=/" > /etc/isaflow/owner.env'
sudo chown root:root /etc/isaflow/owner.env && sudo chmod 0600 /etc/isaflow/owner.env
```

Verify, by count and owner only:
```bash
sudo stat -c '%U:%G %a' /etc/isaflow/owner.env           # root:root 600
sudo grep -c '^OWNER_DATABASE_URL=postgres' /etc/isaflow/owner.env   # 1
sudo -u velo cat /etc/isaflow/owner.env                  # must FAIL: Permission denied
sudo bash -c '. scripts/ops/ownerDatabaseUrl.sh; owner_database_url_for /home/velo/isaflow/.env.local' 2>&1 >/dev/null | grep -c WARNING   # 0
```
The last line, run from the repo, runs the deploy's own lookup with its output
discarded and counts its warnings: 0 means it took the owner file.

5b. Change `/home/velo/isaflow/.env.local`. If `CRON_SECRET` has not been
rotated yet (`docs/runbooks/cron-secret-management-packs.md`), rotate it
first: the copy made here is the rollback point and would otherwise keep the
leaked value. Keep a copy, as velo (a root `cp` into velo's directory would
follow a symlink velo planted): `sudo -u velo cp -p /home/velo/isaflow/.env.local /home/velo/isaflow/.env.local.pre-s07b`.

```
SERVICE_DATABASE_URL=postgresql://isaflow_service:<pw>@<same host:port>/isaflow?<same params>
DATABASE_URL=postgresql://isaflow_app:<pw>@<same host:port>/isaflow?<same params>
```

Do NOT add `OWNER_DATABASE_URL` here; if an earlier attempt added it, remove
it. Leave `PLATFORM_ADMIN_DATABASE_URL` and `MIGRATION_ADMIN_DATABASE_URL` as
they are. The app refuses to boot if `DATABASE_URL` names isaflow_app while
`SERVICE_DATABASE_URL` is unset (validateEnv), so set both together.

Check: `sudo grep -c '^OWNER_DATABASE_URL=' /home/velo/isaflow/.env.local` → 0.

5c. Restart the WAL archiver, a long-running unit that loaded its connection
when it started (step 4's `enable --now` does not restart a running unit):
`sudo systemctl restart isaflow-wal-archive` and check that
`journalctl -u isaflow-wal-archive --since -2min` shows it connected, with no
`OWNER_DATABASE_URL` warning.

One-off owner scripts (for example `scripts/ap-backfill-supplier-payments.ts`)
read `OWNER_DATABASE_URL` from their own environment. Load it inside the
command, so the value never reaches an argv (`/proc/<pid>/cmdline` is
world-readable) or your shell history, and never copy it into `.env.local`:
`sudo bash -c 'export OWNER_DATABASE_URL="$(sed -n "s/^OWNER_DATABASE_URL=//p" /etc/isaflow/owner.env)"; exec bun <script>'`.
Do not `source` the file: a URL's `&` would end the assignment.

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

`/etc/isaflow/owner.env` can stay: it names `postgres`, which is what the
restored `.env.local` names too.

A code rollback to a release from before the follow-up PR, with the env still
on the new logins: that release's change-email updates GoTrue first and then
fails its `users` write (918 took it from the service pool), logs the drift
and answers 200, so the login and profile emails diverge; its register and
verify-email recovery path fail with `permission denied for table
auth_email_verification_tokens` (918). Restore the env first, as above.

**Env first, then code.** Never run `scripts/rollback-deploy.sh` to a release
older than this PR while the env still names `isaflow_app`: the old code
ignores `SERVICE_DATABASE_URL` and has no boot check, so every cron, login and
public route would fail with 42501, and its `deploy.sh` would migrate as
`isaflow_app`. Restore the env and restart first; roll the code back after.

Once the logins can log in, every deploy stops before its code switch if the
event trigger or the reserved roles are missing (for example after the db
container was recreated and `supautils.conf` reverted), so finish steps 2 and
3b before the next deploy, and re-check them after any change to the db
container. The deploy's message names what is missing.

The roles and policies can stay; nothing uses them. To remove the logins as well:
`ALTER ROLE isaflow_app NOLOGIN; ALTER ROLE isaflow_service NOLOGIN;`.

## Dev (optional, after prod is stable)

Dev's workspace `.env.local` can follow the same pattern against
`isaflow_dev`: `SERVICE_DATABASE_URL` and `DATABASE_URL` on the new logins, plus
`OWNER_DATABASE_URL` naming `postgres`. Dev keeps the owner URL in the
workspace `.env.local`: the deploy's parity gate reads it from there
(`owner_database_url`, not the `/etc/isaflow/owner.env` lookup, which is
production's), and no long-running service loads that file.
