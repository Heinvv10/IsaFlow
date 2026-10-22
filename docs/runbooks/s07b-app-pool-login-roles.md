# Runbook: S-07b app pool login roles

Do the steps in this order, after 17:00 SAST on a weekday, with Hein's approval for each.

The PR that ships migrations 910 and 911 changes almost nothing at runtime by
itself. Two things do take effect on deploy: POST /api/invite/[token] writes on
the migration_admin pool (`MIGRATION_ADMIN_DATABASE_URL`, already required by
/api/invitations/[token]/accept), and app_user can no longer write
`schema_migrations`. The roles it
creates have no password and no LOGIN, and every new env var falls back to
`DATABASE_URL`.

## 0. Before you start

- Prod and dev share one PostgreSQL 15.8 cluster (`isaflow-supabase`, port 7772).
  Roles are cluster-wide, so 910 creates `isaflow_app`, `isaflow_service` and
  `app_service` for every database the first time it runs anywhere. The first
  run is normally the deploy's parity gate applying it to `isaflow_dev`.
- The prod env file is `/home/velo/isaflow/.env.local` (velo:velo 0600). You
  edit it as velo, or with sudo.

## 1. Deploy the code (migrations 910 and 911 included)

`bash scripts/deploy.sh`, from a clean worktree at master.

The deploy logs a `WARNING: OWNER_DATABASE_URL is not set` line. That is expected
at this step: the deploy falls back to `DATABASE_URL`, which is still `postgres`.

Verify:
```sql
SELECT rolname, rolcanlogin, rolinherit, rolbypassrls FROM pg_roles
 WHERE rolname IN ('isaflow_app','isaflow_service','app_service');
-- 3 rows, rolcanlogin = false, rolbypassrls = false; isaflow_app rolinherit = false
SELECT count(*) FROM pg_policy WHERE polname LIKE 'app\_service\_%';   -- > 200, in isaflow
SELECT has_table_privilege('app_user', 'schema_migrations', 'DELETE');  -- false (911)
```

## 2. Enable the logins (once per cluster)

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

## 3. Change the prod env (`/home/velo/isaflow/.env.local`)

Keep a copy first: `sudo cp -p .env.local .env.local.pre-s07b`.

```
OWNER_DATABASE_URL=<the current DATABASE_URL value, unchanged (postgres)>
SERVICE_DATABASE_URL=postgresql://isaflow_service:<pw>@<same host:port>/isaflow?<same params>
DATABASE_URL=postgresql://isaflow_app:<pw>@<same host:port>/isaflow?<same params>
```

Leave `PLATFORM_ADMIN_DATABASE_URL` and `MIGRATION_ADMIN_DATABASE_URL` as they are.
The app refuses to boot if `DATABASE_URL` names isaflow_app while
`SERVICE_DATABASE_URL` is unset (validateEnv), so set all three together.

## 4. Reinstall the backup scripts BEFORE the next backup runs

The backup and restore-drill units run root-owned copies in `/opt/isaflow-ops`.
Those copies read `DATABASE_URL`, which would now be `isaflow_app`, and pg_dump
would fail as that role. Reinstall the copies so they read `OWNER_DATABASE_URL`:

`sudo bash scripts/ops/install-backup-ops.sh` (it installs `ownerDatabaseUrl.sh` beside `lib-pgconn.sh`)

Then check: `sudo grep -c OWNER_DATABASE_URL /opt/isaflow-ops/lib-pgconn.sh` (expect ≥ 1).

## 5. Restart and verify

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

The roles and policies can stay; nothing uses them. To remove the logins as well:
`ALTER ROLE isaflow_app NOLOGIN; ALTER ROLE isaflow_service NOLOGIN;`.

## Dev (optional, after prod is stable)

Dev's workspace `.env.local` can follow the same three-variable pattern against
`isaflow_dev`. The deploy's parity gate reads dev's `OWNER_DATABASE_URL` too.
