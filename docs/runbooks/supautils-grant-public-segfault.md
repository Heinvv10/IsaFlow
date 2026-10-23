# Runbook: supautils segfault on `GRANT <role> TO PUBLIC` (whole-cluster restart)

Found during S-07b (2026-10-22); characterised 2026-10-23 on throwaway
containers only. Nothing here has been run against the IsaFlow Supabase stack
(`isaflow-supabase-db`, ports 7770-7776, compose at
`/home/velo/isaflow-supabase/docker-compose.yml`). Every step below that
touches that stack needs Hein's approval, outside business hours.

## What happens

On `supabase/postgres:15.8.1.085` (the image prod and dev run; PG 15.8,
supautils 2.9.1), one statement from **any non-superuser login** kills its
backend with SIGSEGV. The postmaster then ends every other session and runs
crash recovery: every database on the cluster (`isaflow`, `isaflow_dev`, and
anything else on 7772) drops its connections for a few seconds.

The statement need not succeed, or even name a role that exists. A login with
no privileges at all triggers it, so a SQL injection on either app pool
(isaflow_app or isaflow_service, after S-07b) is enough to restart the
cluster. The crash happens before PostgreSQL's own permission check.

Superusers are not affected (supautils skips them). Event triggers cannot stop
it: `ddl_command_start` does not fire for a role GRANT/REVOKE (verified below),
so the S-07b `refuse_app_pool_ddl` trigger does not help.

**Root cause (upstream):** supautils' `T_GrantRoleStmt` handler cast the
grantee list's cells to `AccessPriv`, but they are `RoleSpec` nodes; for the
keyword grantees (`PUBLIC`, `CURRENT_USER`, `CURRENT_ROLE`, `SESSION_USER`) the
role name it reads is NULL. Fixed in supabase/supautils#205 (merged
2026-07-17, released as supautils v3.2.3), reported as supabase/supautils#207.
The open image-level report for 15.8 is supabase/postgres#2348.

## Reproduce (throwaway container only)

```bash
docker run -d --name s07bfu-h-repro -e POSTGRES_PASSWORD=x -p 127.0.0.1::5432 supabase/postgres:15.8.1.085
# wait for the log line "PostgreSQL init process complete", then a few seconds more (it restarts after init)
P=$(docker port s07bfu-h-repro 5432 | cut -d: -f2); export PGPASSWORD=x
psql "postgresql://supabase_admin@127.0.0.1:$P/postgres" -c "CREATE ROLE r NOLOGIN; CREATE ROLE lr LOGIN PASSWORD 'x' NOINHERIT"
psql "postgresql://lr@127.0.0.1:$P/postgres" -c "GRANT nonexistent TO PUBLIC"
#   server closed the connection unexpectedly
docker logs s07bfu-h-repro 2>&1 | grep -A4 "signal 11"
docker rm -fv s07bfu-h-repro
```

Log lines (15.8.1.085, 2026-10-23):

```
LOG:  statement: GRANT s07bfu_r TO PUBLIC
LOG:  server process (PID 282) was terminated by signal 11: Segmentation fault
LOG:  terminating any other active server processes
LOG:  all server processes terminated; reinitializing
LOG:  database system was interrupted; last known up at 2026-10-23 03:32:20 UTC
LOG:  database system was not properly shut down; automatic recovery in progress
LOG:  database system is ready to accept connections
```

## Which statements, which tags

Each row on its own fresh container (`h-probe.sh`, below), as `postgres`
(NOSUPERUSER on every image tested) and as `lr`, a login with no privileges:

| Statement | 15.8.1.085 (prod) | 15.14.1.151 | 15.14.1.152 | 15.19.0.007 |
|---|---|---|---|---|
| `GRANT r TO PUBLIC` (postgres) | SEGFAULT | SEGFAULT | `role "public" does not exist` | same as .152 |
| `GRANT r TO CURRENT_USER` (postgres) | SEGFAULT | SEGFAULT | GRANT ROLE | GRANT ROLE |
| `REVOKE r FROM PUBLIC` (postgres) | SEGFAULT | SEGFAULT | `role "public" does not exist` | same |
| `GRANT r TO PUBLIC` (lr, no privileges) | SEGFAULT | SEGFAULT | error, no crash | error, no crash |
| `GRANT nonexistent TO SESSION_USER` (lr) | SEGFAULT | SEGFAULT | `role ... does not exist` | same |

Also on 15.8.1.085: `TO CURRENT_ROLE` and `TO SESSION_USER` as postgres crash;
`GRANT r TO <a role name>` does not; `GRANT r TO PUBLIC` as `supabase_admin`
(superuser) answers `role "public" does not exist`. A `ddl_command_start`
event trigger that raises on every tag fired for `CREATE TABLE` and for an
object `GRANT SELECT ON ...`, did not fire for `GRANT r TO r2`, and did not
stop `GRANT r TO PUBLIC` from crashing the cluster.

**Affected:** every `15.8.1.x` tag (the 15.8.1 line stopped at 15.8.1.135 in
2025-09, a year before the fix) and `15.14.1.x` up to `.151`.
**Fixed:** `15.14.1.152` (2026-07-22) and later, including the `15.19.0.x` line.

## Mitigation

### Recommended: move the stack to a fixed image

Pin `supabase/postgres:15.14.1.152` or later in
`/home/velo/isaflow-supabase/docker-compose.yml` (line ~518, the `db` service),
by exact tag. Same PostgreSQL major (15), so the data directory is reused; no
dump/restore.

Checked on a throwaway volume: initialised on 15.8.1.085, stopped, started on
15.14.1.152. The data came back, the crash was gone, and two things need
handling in the window:

1. **Collation version mismatch.** The newer image's glibc is 2.40, the old one
   2.39: `WARNING: database "postgres" has a collation version mismatch ...
   created using collation version 2.39, but the operating system provides
   version 2.40`. Text indexes built under 2.39 may order differently under
   2.40 (wrong results, unique-index misses). In each database (`isaflow`,
   `isaflow_dev`, `postgres`, `_supabase`, and any other on the cluster), as
   supabase_admin: `REINDEX DATABASE <db>;` then
   `ALTER DATABASE <db> REFRESH COLLATION VERSION;`. Time the REINDEX on a
   restored copy first (the restore drill's copy is the right size).
2. **Extension versions.** `pg_graphql` stayed at 1.5.11 with 1.6.1 available.
   List the rest with `SELECT name, installed_version, default_version FROM
   pg_available_extensions WHERE installed_version <> default_version;` and
   update each only after checking its release notes.

Order (each step approved; after 17:00 SAST on a weekday):

1. Rehearse on a copy: restore the latest base backup into a throwaway
   container on the NEW tag, run the REINDEX and the extension check there,
   and time both.
2. Take a fresh base backup (`isaflow-basebackup.service`).
3. Stop the app (`sudo systemctl stop isaflow`) and the cron timers.
4. In the compose file, change the db image tag; `docker compose up -d db`
   (only the db service). Wait for `ready to accept connections`.
5. Check that `/etc/postgresql-custom/supautils.conf` (the `db-config` volume)
   still lists `isaflow_app, isaflow_service` in `reserved_roles` (S-07b step
   3b), and that the S-07b event trigger exists in `isaflow`.
6. REINDEX and REFRESH COLLATION VERSION per database (above).
7. Start the app and timers; run the S-07b runbook's step 6 checks.
8. Never run the repro on the live cluster, fixed or not: check the image tag
   instead, `docker inspect isaflow-supabase-db --format '{{.Config.Image}}'`.

Rollback: stop db, put the old tag back, start. The data directory written by
15.14 starts on 15.8 (same major), but indexes rebuilt under glibc 2.40 must
then be rebuilt again under 2.39: keep the base backup from step 2.

### Interim (optional, a trade-off for Hein): supautils off for the two app logins

Without changing the image, a superuser can stop supautils loading in the app
logins' sessions only:

```sql
-- as supabase_admin, once per cluster
ALTER ROLE isaflow_app     SET session_preload_libraries = 'plpgsql';
ALTER ROLE isaflow_service SET session_preload_libraries = 'plpgsql';
```

(`''` does not work: the login then fails with `could not access file ""`.
`plpgsql` is already loaded, so naming it changes nothing else.)

Verified on 15.8.1.085: the login's `GRANT r TO PUBLIC` then answers
`role "public" does not exist` with no crash, and the login cannot undo the
setting (`ALTER ROLE ... RESET session_preload_libraries` and
`options=-c session_preload_libraries=...` are both refused).

**What it costs:** supautils is also what enforces `reserved_roles` (S-07b
runbook step 3b) in that session. With it off, the login can `ALTER ROLE` itself
again (verified: `ALTER ROLE lr SET statement_timeout = 1` succeeded), so an
injection could make the app read-only or change the login's password. That is
an IsaFlow-only, superuser-reversible outage, against a cluster-wide crash.
`app_login_role_violations()` keeps reporting step 3b as done (it reads the
server setting), so the deploy check would not notice this. It also removes
supautils' privileged CREATE EXTENSION path for the logins, which is a gain.
Do not combine it with the image upgrade; once on a fixed tag, reset both
settings.

## Upstream issue draft

supabase/postgres#2348 already reports `GRANT <role> TO CURRENT_USER` on
15.8.1.060 and is open. Rather than a new issue, add this comment there:

> Same crash on `supabase/postgres:15.8.1.085` (supautils 2.9.1), with a wider
> trigger than the report says. The grantee keyword `PUBLIC` crashes too, as do
> `CURRENT_ROLE`, `SESSION_USER` and the `REVOKE ... FROM PUBLIC` form. It needs
> no privilege at all: a login created with only `LOGIN NOINHERIT` crashes the
> cluster with `GRANT nonexistent_role TO PUBLIC`, so any SQL injection against
> an app that logs in as a non-superuser can restart the whole instance.
> Superusers are unaffected; a `ddl_command_start` event trigger does not fire
> for role GRANT and cannot prevent it.
>
> Tested 2026-10-23 on fresh containers: 15.14.1.151 crashes; 15.14.1.152 and
> 15.19.0.007 answer `role "public" does not exist`, consistent with the fix in
> supabase/supautils#205 (v3.2.3). The 15.8.1.x line (last tag 15.8.1.135,
> 2025-09) never received it. Could the 15.8.1 line get a patch release with
> supautils >= 3.2.3, or could the upgrade note for 15.8.1 -> 15.14.1.152 call
> out the glibc 2.39 -> 2.40 collation change (REINDEX needed)?
>
> Repro:
> ```sql
> -- as supabase_admin
> CREATE ROLE lr LOGIN PASSWORD 'x' NOINHERIT;
> -- as lr
> GRANT nonexistent_role TO PUBLIC;   -- server closed the connection unexpectedly
> ```
> Log: `server process (PID 282) was terminated by signal 11: Segmentation fault`,
> then `terminating any other active server processes`.

Posting it is an outward action: Hein decides.

## How the table was produced

A script that starts `supabase/postgres:<tag>` as a container named
`s07bfu-h-<tag>`, waits for init, runs the five statements (one per fresh
connection, counting `signal 11` lines in the log before and after each), and
removes the container with `docker rm -fv` by name. Images pulled by exact tag.
No `docker system prune`, nothing on the live stack.
