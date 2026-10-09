# R-035 N3 design spike: caller-set claims, the exemption GUC, and the role escape

A design, not a build. Nothing here has been implemented.

**Sources:**
- the code at `origin/master` `e0b15ae60`;
- the catalog of the disposable fixture `isaflow_schema_fixture` (read-only `pg_catalog` and `information_schema` queries);
- two throwaway PG16 clusters in my scratchpad, both deleted afterwards. The second one was driven by the repo's own `pg` 8.20.0 client;
- the host's systemd units, `docker inspect` (secrets masked), and `sudo -n -l`.

I did not connect to prod `isaflow` or to `isaflow_dev`, and I did not open any file readable only through sudo. Where a claim depends on prod, it says so, and Q2 gives the SQL for Hein to run.

## 0. Facts that change the plan

1. **SQL injection in a request runs as the login role, not as `app_user`.**
   - `withAuth` connects with `DATABASE_URL` (`authPool.ts:24-27`), then runs `SET LOCAL ROLE app_user` (`withAuth.ts:102`).
   - One injected expression undoes that: `set_config('role','none',true)` (or `RESET ROLE`, or `SET ROLE postgres`). On the scratch cluster, `current_user` went back to the login role, and an UPDATE refused to `app_user` then succeeded.
   - The login role is the schema owner. Prod migrations run with the same `DATABASE_URL` (`scripts/deploy.sh:144-146`, `apply-migrations.ts:150`).
   - **The two memory notes disagree about that role.** The deploy note (`project_deployment.md:44`, 2026-10-05) says prod's `postgres` is not a superuser, but is BYPASSRLS and a member of `migration_admin`. The older infra note (`project_velo_supabase_infra.md:42`, 2026-04-19) says `postgres` is a superuser, and that `migration_admin` is "used by apply-migrations.ts". The code contradicts the second half of that: migrations run with `DATABASE_URL` (`deploy.sh:144-146`, `apply-migrations.ts:150`). Q2 settles both. This doc assumes the newer note, and P0 says what changes if the older one is right.
   - On the fixture, and in any stock-docker CI database, `postgres` IS a superuser (`pg_roles.rolsuper = t`). A superuser can read server files, run `COPY … PROGRAM` (a shell in the DB container) and skip every trigger with `session_replication_role`.
   - The owner alone can `ALTER TABLE … DISABLE TRIGGER`, `CREATE OR REPLACE` any definer function, and write any row past RLS.
   - So today an injection gets the owner, or a superuser. Until §3 (P0) is done, PR B's REVOKE and every SECURITY DEFINER check stop application bugs, not attackers.
2. **Injected statements can be stacked.**
   - `sql.unsafe`/`sql.query` default to `values = []` (`neon/sql.ts:62-65`), and so does a tagged template with no interpolations. `LazyQuery.run` passes the values straight to `client.query` (`neon/query.ts:43,52,55`).
   - `pg` 8.20.0 sends a query with no values over the **simple** protocol (`node_modules/pg/lib/query.js:35-57`), which accepts several `;`-separated statements.
   - Proven with that client on the scratch cluster: inside a transaction, `SELECT 1; COMMIT; BEGIN; SELECT txid_current()` ran four statements and returned a new transaction id.
   - So an injection can end the request's transaction and start its own. The same text with a bound value, or with `queryMode: 'extended'`, is refused with "cannot insert multiple commands into a prepared statement".
3. **The login credential is in every worktree.**
   - `isaflow_dev` and `isaflow` are two databases on one cluster (port 7772), and roles belong to the cluster, not to a database.
   - So the `postgres` user and password in `.env.local` (12 worktree copies, mode 0640, group `gha-isaflow`) are prod's owner credential, unless `pg_hba` restricts by database. A reviewer has already reached prod this way (memory "Database targets").
   - The same holds for `MIGRATION_ADMIN_DATABASE_URL` and `PLATFORM_ADMIN_DATABASE_URL` in that file.
4. **The GoTrue signing secret is shared between dev and prod, and it is in every worktree.**
   - The SHA-256 of `JWT_SECRET` in the workspace `.env.local` equals that of `GOTRUE_JWT_SECRET` in the `isaflow-supabase-auth` container. I compared digests only; no value was recorded.
   - The app accepts any HS256 token signed with it (`gotrue.ts:50-56`). A token claiming `aal: 'aal2'` is accepted without asking GoTrue (`gotrue.ts:66`).
   - So whoever holds that file can mint a prod session for any user over HTTP. That needs no SQL.
5. **Agent sessions have root.**
   - `sudo -n -l` for user `hein` lists `(ALL) NOPASSWD: ALL` and `(velo) NOPASSWD: ALL`.
   - `hein` is also in the `docker` group, which is root-equivalent: `docker exec` into `isaflow-supabase-db` is DB superuser.
   - So every agent session on this box can read the prod env (`/home/velo/isaflow/.env.local`, 0600 `velo`) and act as DB superuser. I stated this from `sudo -n -l` and `id` only; I did not use either.
6. **`platform_admin` and `migration_admin` can write `approval_requests` directly.**
   - On the fixture, `platform_admin` holds INSERT, UPDATE and DELETE, and is BYPASSRLS.
   - `migration_admin` also holds TRUNCATE and TRIGGER. TRUNCATE fires no row trigger, and an INSERT/UPDATE/DELETE REVOKE does not remove it. `migration_admin` is NOLOGIN on the fixture, but LOGIN on prod according to memory "Supabase infra", the same note whose superuser claim conflicts with the deploy note (fact 1).
   - The insert guard waves BYPASSRLS and superuser roles through (`869_manual_journal_approval_enforcement.sql:488-492`).
   - PR B's REVOKE must name both roles, including TRUNCATE and TRIGGER, or either can forge an approval.
7. **The switch and rule tables are unguarded.**
   - `app_user` holds INSERT, UPDATE and DELETE on `approval_enforcement` and `approval_rules`.
   - Their only guard is the `tenant_isolation` RLS policy, and neither table has a trigger (fixture catalog).
   - The 712 backstop returns as soon as no switch row is found (`712_…:149`).
   - So `DELETE FROM approval_enforcement …`, or deactivating or raising a rule, turns enforcement off with no forged claims and no GUC. The app paths audit these changes (`approvalRuleGuards.ts:198`, `auditRuleChange`); raw SQL does not.
8. **The two GUCs the controls trust are ordinary settings.**
   - `request.jwt.claims` is what `auth.uid()` reads (`348_rls_and_auth_helpers.sql:51-54`).
   - `isaflow.approval_gate_exempt` is the import and bank-feed exemption.
   - Any session can `set_config` either one (shown as `app_user` on the scratch cluster).

## 1. Threat model

| # | Actor | What they can do today | Evidence |
|---|---|---|---|
| T1 | **Holder of a DB credential, or of host access.** The prod app process; `deploy.sh`; every worktree's `.env.local` (fact 3); and through fact 5, every agent session. | Anything, as the owner or as superuser: disable triggers, replace definer functions, read any table, write approved rows, TRUNCATE. | fixture: `postgres` owns `approval_requests` (FORCE RLS, but the role is BYPASSRLS); facts 1, 3, 5 |
| T2 | **Holder of `JWT_SECRET`.** The same files, the GoTrue container and the prod env (fact 4). | Mint an aal2 token for any user and drive the real app as them. Every TS and SQL check sees a legitimate user. | `gotrue.ts:66`, `gotrue.ts:192-206` (the app mints tokens itself) |
| T3 | **SQL injection inside a request transaction.** Any wrapper that does `SET LOCAL ROLE app_user`: `withAuth`, `bearerPipeline`, `withExtensionToken`, `withInviteToken`, `switch-company`, and `withPlatformAdmin`'s gate transaction. | **Today:** escalate to T1 (fact 1). **After P0-i:** whatever `app_user` can do, as any identity it likes. It can forge `request.jwt.claims`, set the exemption GUC, read every tenant through RLS (which keys on the forged `sub`), and, while statements stack (fact 2), commit, start and rebind its own transactions. | `withAuth.ts:101-104`, `bearerPipeline.ts:134-142`, `withExtensionToken.ts:102-106`, `withInviteToken.ts:58-59`, `switch-company.ts:25-27`, `withPlatformAdmin.ts:75-78` |
| T4 | **SQL injection in an owner-pool path.** Bare `sql` outside ALS, `withAlsTransaction`, `withPublicRouteTransaction` (Paystack webhook, portal verify), the 14 cron routes, and the `afterCommit` work. | T1 directly. These paths run as the owner with no claims. | `neon/pool.ts:20,40`, `alsTransaction.ts:38-41`, `publicRouteTx.ts:16-21` |
| T4b | **SQL injection in a `withPlatformAdmin` handler.** | `platform_admin`: BYPASSRLS, with DML on `approval_requests`, `approval_rules` and `approval_enforcement` (facts 6, 7). | `withPlatformAdmin.ts:120-130` |
| T5 | **An application bug.** A mis-wired path, or a write that forgets a check. | Writes the wrong row with the right claims. This is the class PR B's SQL re-checks target. | the R-035 review rounds |
| T6 | **Config tampering.** T3 after P0, T4b or T5 rewrites the switch or rule tables (fact 7). | Turns a type's enforcement off, or deactivates or raises a rule, then posts through the ordinary path. This needs no forged approval, claim or GUC, so (b) and (c) do not touch it. | fixture grants; `712_…:149` |

**How large is the injection surface?** `sql` is a parameterised template, so an injection needs one of the 153 `sql.unsafe(` / `sql.query(` call sites, or one of the 7 `client.query(\`…${…}\`)` sites, to interpolate input. I counted them; I did not audit them.

**Plainly:** the database cannot tell the app from an attacker who runs SQL in the app's transaction.
- `auth.uid()` returns whatever `request.jwt.claims` says, and any statement can rewrite it.
- PR B's definer functions take the actor from `auth.uid()` (goal §4). An injection approves as anyone it names, provided it also passes the rank, author, requester and digest checks.
- The same forgery defeats the Login-as refusal.
  - `assertNotImpersonating` (`approvalDocuments.ts:205`) refuses only when the claims' `session_id` matches an `impersonation_sessions` row (`impersonationSessions.ts:56,61`; `impersonationGuard.ts:35-36`).
  - An absent or random `session_id` passes.
- Against T1 and T2 nothing in the database helps. Against T3 nothing helps until P0 is done.

## 2. The bypasses the backstops trust

### 2a. The exemption GUC

**Readers:**
- the supplier-invoice backstop (`712_…:142`) and the customer-invoice backstop (`865_…:346`) skip on `'import'`;
- the supplier-payment backstop skips an INSERT on `'bank_feed'` (`867_…:491-492`).

**Setters:** only the two TS wrappers (`approvalGateExempt.ts:89-94`, `:121-126`), pinned by `approvalGateExemptCensus.test.ts`. They have nine callers:
- import: `migrationApService.ts:234`, `migrationImportService.ts:154`, `sageCustomerImportService.ts:133`, `sageSupplierInvoiceImportService.ts:141`, `sageMigrationCommitService.ts:168` and `:276`. Both `sageMigrationCommitService` sites run inside `withPlatformAdmin`'s `platform_admin` transaction: `pages/api/admin/migration/sage-commit.ts:84` → `withAdmin` (`withAdmin.ts:7,12`);
- bank feed: `provisionalInvoiceSettlement.ts:105`, `supplierAutoAllocate.ts:142`, `supplierBankPaymentService.ts:229`.

**What the SQL does not check:**
- **Rank:** the import exemption's rank check lives only in TS (`approvalGateExempt.ts:88`).
- **Provenance:** the bank-line check lives only in TS (`:120`).
- So `SELECT set_config('isaflow.approval_gate_exempt','import',true)` followed by `UPDATE supplier_invoices SET status='approved'` passes 712 with no rank and no approval. The census pins who *should* set the GUC; it cannot stop anyone else.

### 2b. The switch and rule tables (T6)

- A `DELETE` from `approval_enforcement`, an `UPDATE approval_rules SET is_active = false`, or a raised `condition_value` each make every gate, TS and SQL alike, see "not enforced" or "no rule".
- This is cheaper than the GUC, and it leaves no request row behind to detect.
- After PR B it is the cheapest bypass left for T3 and T5. The GUC comes second.

## 3. Prerequisite P0: make `app_user` a real boundary

None of the options in §4 means anything against T3 while the role escape lands on the owner, or while injected statements can stack.

**Why the escape works.** `SET ROLE` changes only `current_user`. Any statement may switch back to the session user, or to any role the session user belongs to. That is documented Postgres behaviour.

Every pool logs in with `DATABASE_URL`:
- `authPool.ts:24-27`;
- `bearerPipeline.ts:46-60`;
- `withExtensionToken.ts:43-50`;
- `withPlatformAdmin.pools.ts:23-37` (the gate pool);
- `neon/pool.ts:20,40` (the owner pool behind every bare `sql`).

The same URL runs prod migrations (`deploy.sh:144-146`).

**(P0-i) A dedicated request login role.** Recommended.
- The role is `isaflow_web`: LOGIN, NOINHERIT, not a superuser, not BYPASSRLS, owning nothing, a member of `app_user` only.
- The request pools read a new `APP_DATABASE_URL`: `authPool`, `bearerPipeline`, `withExtensionToken`, `withInviteToken`, `withPlatformAdmin`'s gate pool, and `switch-company`. `switch-company` opens a `withTransaction` on the owner pool and then runs `SET LOCAL ROLE` (`switch-company.ts:25-27`), so it would move to the request pool.
- `SET LOCAL ROLE app_user` stays, so policies and grants are unchanged.
- On the scratch cluster: after the escape, `current_user` is `isaflow_web`, and the refused UPDATE stays refused.
- **One residue.** Every request backend now shares the session user `isaflow_web`, so after the escape an injection can:
  - read other request backends' `pg_stat_activity.query` (only the SQL text and `$n` placeholders, under the extended protocol);
  - `pg_cancel_backend` / `pg_terminate_backend` them.

  That is a denial of service, not a write.

**(P0-ii) Log in directly as `app_user`.**
- Same closure, and no new role.
- But `app_user` becomes a credential, and the 348 design (NOLOGIN on purpose) and the RLS memory's assumptions change. Not recommended.

**(P0-iii) A non-owner role for the owner pool.**
- `isaflow_jobs`: LOGIN, BYPASSRLS, DML grants only, owning nothing. It cannot disable triggers or replace definer functions. Migrations move to their own URL.
- This shrinks T4, but every future migration must grant to it, and a missed grant 500s a cron or a webhook. About 2 to 3 days.

**(P0-iv) No stacked statements on request connections.**
- Every request-pool query passes `queryMode: 'extended'`: in `LazyQuery.run` (`neon/query.ts:43,52`) and in the wrappers' own `client.query` calls.
- Shown on the scratch cluster: a stacked query is then refused.
- It also stops an injection committing part of a request that `withAuth` would have rolled back, by stacking `COMMIT`.
- It does **not** stop *whole-statement* injection: a call site whose entire text is attacker-controlled can send a lone `COMMIT`, which the extended protocol accepts (shown on the scratch cluster). Later statements in that request then run in autocommit.
- **Census needed:** any call site that sends several statements on purpose breaks.

| | P0-i | P0-iii | P0-iv |
|---|---|---|---|
| **Migration** | None in `scripts/migrations`. The role is cluster-level: `CREATE ROLE` plus `GRANT app_user`, run once per cluster (prod, the dev cluster, the CI fixtures). Outside production, an unset `APP_DATABASE_URL` falls back to `DATABASE_URL`, so `isaflow_dev`, CI and the golden paths are unaffected. **In production the fallback would fail open:** a missing variable silently brings back the owner escape. So the request pool asserts its session user on first connect: not a superuser, not BYPASSRLS, owning no relation (`NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = session_user))`), and a member of `app_user` and nothing else, so that `SET ROLE` can reach no other role (`SELECT array_agg(roleid::regrole) FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = session_user)` must equal `{app_user}`). Under `NODE_ENV=production` a failed assertion stops the server from starting; elsewhere it logs a warning. `verify-deploy.sh` runs the same query. Reversible: point the variable at the old URL, which the assertion then refuses in prod, so the rollback is a deliberate code revert. | Grants on every table, and `ALTER DEFAULT PRIVILEGES`. Reversible. | None. Code only. Reversible. |
| **Cost** | 1 to 2 days, with a real-PG test per wrapper: run the escape, assert the resulting role has no write privilege on `approval_requests` and no BYPASSRLS. Mutant: point the pool back at `DATABASE_URL`. | 2 to 3 days | 1 day, plus the census |
| **Rollout risk** | Low to medium. Inside these transactions everything already runs as `app_user`, and no code does `RESET ROLE` / `set_config('role', …)` (`git grep`: none). A prod env change and a new role, so §8. | High care | Medium. A deliberate multi-statement call site 500s until it is split. |

**If the prod login role is a superuser after all** (the older memory note; Q2): P0-i becomes urgent rather than desirable. The escape then reaches a superuser, so `COPY … PROGRAM` gives a shell in the DB container and `session_replication_role` skips every trigger.

**What P0-i plus P0-iv closes:** T3's escalation to T1, and stacked-statement transaction control.

**What it does not close:**
- T1, T2, T4, T4b, T6;
- whole-statement injection's lone `COMMIT`;
- T3 forging identity within `app_user` (that is §4).

## 4. Options

For each option, **Migration** says what it adds, whether `isaflow_dev` must have it before the golden paths run (applying it there is a §8 gate), and whether it can be reversed.

**Rule for every protected object an option adds.** This rule is part of each option's Migration line.
- **Why it is needed.** The fixture's default privileges (`pg_default_acl`) give, on every new table in `public`:
  - `app_user=arwd`;
  - `platform_admin=arwd`;
  - `migration_admin=arwdDxt`;
  - on sequences: `app_user=rU`, `platform_admin=rU` and `migration_admin=rwU` (SELECT, UPDATE, USAGE).

  `platform_shared` has the same rule for `app_user`, and the `app` and `auth` schemas grant `platform_admin` EXECUTE on new functions. Postgres itself also grants EXECUTE on every new function to `PUBLIC`.
- **What a plain `CREATE TABLE` gets wrong.** It would ship each of these open to an injection:
  - (a)'s secrets table, which would hand out `JWT_SECRET`;
  - (b)'s binding table, which an injection could simply UPDATE;
  - (c2)'s exemption table;
  - (d)'s history;
  - (f2)'s log.

So each such migration must:
1. Create the protected tables in a dedicated schema with no default ACL, for example `approval_private`, and `REVOKE ALL ON SCHEMA approval_private FROM PUBLIC`.
2. Still `REVOKE ALL` on each table explicitly from `PUBLIC`, `app_user`, `platform_admin` and `migration_admin`, and from `isaflow_web` and `isaflow_jobs` if P0 created them.
3. On each new function, `REVOKE EXECUTE … FROM PUBLIC` and then grant EXECUTE only where it is meant to be.
4. Assert all of this in a plpgsql `DO` block, using the role-argument forms so the migration never switches role: `has_table_privilege('app_user', 'approval_private.<table>', 'INSERT,UPDATE,DELETE,TRUNCATE,SELECT')` and `has_function_privilege('app_user', '<fn>(…)', 'EXECUTE')`, repeated for each role. Each must be false wherever access is not meant to be granted.

   The assertion must be plpgsql, not an SQL `CASE`. A REVOKE from a role is a no-op while `PUBLIC` still holds the grant, so only checking the effective privilege proves it (memory "REVOKE ships as a no-op", "Privilege guard ≠ SQL branch").

A catalog test in CI repeats the assertion, and the mutation is to drop one REVOKE.

The golden paths log in with a cookie session (`tests/e2e/golden-paths/_api.ts:5`), so every call goes through `withAuth`. None raises or decides an approval, or writes a rule or a switch.

### (a) Verify a signed credential inside the definer functions

**Shape:** the app passes the raw credential. A definer function verifies it and takes the actor from it, not from the GUC.

**Facts:**
- GoTrue signs HS256: no `GOTRUE_JWT_ALGORITHM`/`GOTRUE_JWT_KEYS` is set, and the app verifies HS256 only (`gotrue.ts:56`).
- `pgjwt` is not on the fixture, and the prod image was not checked. `pgcrypto` 1.3 is installed, and `hmac(…,'sha256')` works. A verifier is about 40 lines of plpgsql.
- **Credentials that are not GoTrue tokens:**
  - PAT and OAuth bearer calls synthesize their claims (`bearerPipeline.ts:140`). Their tokens are stored as SHA-256 (`personalAccessTokens.ts:45,57`, `oauth.ts:41-47`), so SQL can verify them with `digest()`.
  - The extension signs with `EXTENSION_SIGNING_KEY` (`extensionJwt.ts:43,88`) and synthesizes claims (`withExtensionToken.ts:105-106`).
  - Print tokens (`printAuth.ts:77`) authorise GET only.
  - The cron, public-route and `withAlsTransaction` paths have no principal. None of them raises or decides an approval: every raiser is a `withAuth` route (`capture/[id]/post.ts:299`, `ai-invoice-pipeline.ts:295`, `recurring-invoices-run.ts:149`, `recurring-transactions-execute.ts:78`, `recurring-invoices-action.ts:64`).
  - So (a) means three verifiers, with `JWT_SECRET` and `EXTENSION_SIGNING_KEY` copied into the DB.
- **Expiry:** `GOTRUE_JWT_EXP=3600`. Verifying on every call fails a long import halfway through. Verifying once per transaction avoids that, which is the (b+a) shape below.
- **Impersonation:** the definer looks up the verified token's `session_id` in `impersonation_sessions` itself.
- **Replay:** an injection can only reuse its own request's token. Other users' tokens are not stored in `isaflow`; GoTrue's tables live in the cluster's `postgres` database (`GOTRUE_DB_DATABASE_URL`).
- **New exposure:** every DB backup then contains `JWT_SECRET`. Vault/pgsodium would keep the key outside the DB, but it was not checked.

**Migration:** a definer-only secrets table and the verifier functions (both under the protected-object rule above), and an extra argument on every request write function. If the app calls them on golden paths, `isaflow_dev` needs it first. Reversible.

**Closes:** T3 (after P0-i) acting as someone else, even by whole-statement injection; T5 mis-binding a user.

**Does not close:** T1 (it reads the secrets), T2, T4, T6.

**Cost:** 4 to 6 days in all: three verifiers at about a day each, plus threading the credential into every request write function. As (b+a) the same verifiers run once per transaction, which is how (b+a)'s 5 to 7 days is made up: (b) 2 to 3, plus 3 to 4 for the verifiers.

**Rollout risk: medium.**
- Secret rotation must be lock-step with GoTrue.
- A missed rotation 500s every approval.

### (b) A request binding written once per transaction

**Shape:**
- An UNLOGGED definer-owned table, one row per backend pid: transaction start (`now()`), user, company, auth method and impersonation flag.
- Every wrapper calls `isaflow_bind_request(...)` right after `BEGIN`, in the round trip that already carries the `set_config`s (`withAuth.ts:103-104` and its siblings).
- A second bind in the same transaction raises.
- PR B's functions read the actor from a definer `request_actor()`, and refuse (and alert) when `auth.uid()` disagrees.
- An unbound context gets NULL and is refused. That is safe, because no unbound path raises or decides (see (a)).
- Shown on the scratch cluster:
  - after the role escape, a rebind in the same transaction is refused;
  - forged claims leave `request_actor()` unchanged.

**Where the anchor fails (review round 1).** "First writer wins" protects only the transaction the wrapper bound. Two ways around it:
- **Stacked statements** (fact 2): `…; COMMIT; BEGIN; SELECT isaflow_bind_request('<victim>', …); …` gives the injection its own transaction. The bind trusts its arguments, so the injection binds as anyone. P0-iv closes this.
- **Whole-statement injection** survives P0-iv: a lone `COMMIT`, after which the request's later statements autocommit, and a second injected statement binds and acts in one go.

**Two variants:**
- **(b) alone, with P0-iv.** Closes partial-statement injection only.
- **(b+a): the bind verifies the credential**, using (a)'s verifiers once per transaction. An injection can then bind only as the identity it holds a credential for. This closes whole-statement injection too, and avoids (a)'s mid-transaction expiry.

**Migration:** the binding table, `isaflow_bind_request` and `request_actor`, under the protected-object rule. An `app_user`-writable binding table would need no stacking at all to forge. Every request binds, so `isaflow_dev` must have it before the code reaches the golden paths: a §8 gate. A wrapper that tolerates the function's absence would fail open, so it must not. Reversible: drop the objects and revert the code.

**Closes:**
- (b) with P0-iv: T3 acting as another user via a partial-statement injection; the impersonation flag; T5's forged-actor bugs.
- (b+a): the same, plus whole-statement injection.

**Does not close:**
- T1, T2, T4, T4b (which binds as itself), T6;
- a wrapper that forgets to bind (a census test must pin each `SET LOCAL ROLE app_user` to a bind);
- an injection acting as its own user (the rank, author and requester checks cover that).

**Cost:** (b) 2 to 3 days; (b+a) 5 to 7 days.

**Runtime:** one call per request in an existing round trip, and one UPDATE per request, GETs included. That is an XID per request: noise against the freeze horizon, but a write on every read.

**Rollout risk: low** until PR B's functions switch to `request_actor()`. After that, an unbound approval write is a fail-closed 500.

### (c) Move the exemptions into definer functions and drop the GUC

**(c1) Move the nine exempt writes into definer posting functions.** Rejected: it rewrites wide importer INSERTs, with high drift risk.

**(c2) Keep the TS writes, and replace the GUC with a definer-issued exemption bound to the transaction.** This uses (b)'s binding.
- **`approval_gate_exempt_begin(company, 'import', open)`** re-checks the rank in SQL against the bound actor. `approval_rule_strictest_rank` exists for this: it is defined in 862 (`862_…:92`) and called by 865 (`865_…:355`).
- **`approval_gate_exempt_begin(company, 'bank_feed', bank_tx_id)`** re-checks the line's provenance (`bank_feed_connection_id` or `import_batch_id`).
  - `supplier_payments` has no bank-transaction column, only `bank_account_id`, and no `bank_transactions` column names a supplier payment (fixture catalog).
  - So pinning the exemption to the payment it covers needs a new column, or an exemption that covers exactly one payment INSERT.
- The three triggers check for a live exemption row instead of the GUC. The two TS wrappers call `…_begin`/`…_end`, so their nine callers do not change. `withPlatformAdmin`'s Sage commit must bind.

**Migration:**
- an exemption table and the begin/end functions, under the protected-object rule;
- `CREATE OR REPLACE` of the 712, 865 and 867 trigger functions;
- for the bank-feed narrowing, possibly a `supplier_payments` column.

If the code ships without it, imports lose their exemption on `isaflow_dev`. No golden path imports, so that is a dev regression, not a golden failure. Applying it to `isaflow_dev` is still §8. Reversible: restore the trigger bodies.

**Closes:** setting the GUC by hand (T3 after P0, and T5); an import below rank; a bank-feed exemption for a hand-keyed line. All of this holds only as far as (b)'s anchor holds.

**Does not close:** T1, T2, T4, T6.

**Cost:** 2 to 3 days on top of (b).

**Rollout risk: medium, and §8.** It changes how live supplier-invoice enforcement (712) decides, and the outcomes must be identical.

### (d) Detect: app-signed decisions, exemptions and configuration changes

**Why the naive form fails.** An audit trigger cannot know whether a row had "a matching app session". The database has no app-only fact to compare against.

**A buildable form:**
- **What is signed.** The TS paths compute an HMAC with a key held only in the app's prod env, never in the DB. They sign each decision (request id, company id, document type, document id, decision, actor, digest, time). `approval_document_digest()` hashes content only, not company, type or id (`869_…:152-177`). Without the binding, an owner-level attacker could re-point a signed approval at another document with identical content, and the MAC would still verify. They also sign each exemption use (company, kind, document type, document id), and each switch or rule change (the full new state).
- **Prevention.** The TS gate (`assertApprovalCleared`) refuses an approval whose MAC is missing or wrong. That stops forged approvals for every posting that goes through the app.
- **Detection.** A nightly job, run off the DB, rebuilds each company's enforcement state from the signed switch and rule history alone. It then:
  - alerts when the live tables differ from that state (T6);
  - walks **every** document that entered a population, in every company, and alerts when the signed state says it needed approval but it has neither a valid approval nor a valid exemption.
- Walking documents rather than requests catches a forged request that was deleted after use. Walking every document, not only those "under enforcement", catches a switch that was turned off and back on.
- **The history is a hash chain (review round 2).** If each history entry were signed on its own, deleting the latest "enabled" or "rule created" entry together with the live row would leave a rebuilt state of "never enforced". That would match the live tables, and nothing would alert. So:
  - each switch or rule entry carries a per-company sequence number;
  - its MAC covers that sequence number, the previous entry's MAC and the new state;
  - the nightly job stores the last chain head it verified (sequence number and MAC) **outside the DB**, and outside this host once item 1 has removed agents' root;
  - it alerts on a gap, a broken link, a MAC it cannot verify, or a head older than the stored one.

  - **The head is also pushed off the DB when each entry is written.** Within the same request, after COMMIT, through `afterCommit`, the app sends the new head (company, sequence number, MAC) to an off-DB sink: an append-only log on another host, or the alert channel. The job checks the DB chain against the latest pushed head, not only against its own stored head. Without the push, an entry appended after the job's last run (say, a switch turned on this morning) could be deleted along with its live row before the next run, and the chain would end cleanly at the stored head.

  So, with the push, deleting, truncating or rewriting any part of the history alerts on the next run. Without it, that holds only for history the job has already verified. A push that fails is itself alerted on. What remains is an entry deleted in the instant between COMMIT and the push, and that needs the attacker to race the app.
- **What the chain does not cover.** Decisions and exemption uses need no chain, because the document walk judges every document against the chained state, so deleting one of those rows still alerts. A document deleted outright is outside the walk: the GL integrity checks are the control there, and that is out of scope.

**Migration:** nullable MAC columns on `approval_requests`, `approval_enforcement` and `approval_rules`, plus an append-only exemption log and the chain table, all under the protected-object rule. It is additive. If the TS writes the columns unconditionally, `isaflow_dev` needs it before the golden paths (as 869 noted); a conditional write avoids that. Reversible.

**Closes or detects:**
- T3 (with or without P0), T4, T4b, T5, T6, because the chain and the off-DB head make cutting the history visible;
- T1, for any holder without the key. Today that excludes no agent session: fact 5 means every session can read the prod env, so this holds only once item 1 below removes that access.

**Does not close:**
- raw-SQL posting that skips the TS gate (the DB backstop cannot see the MAC). That is detected the next morning, not prevented;
- an attacker who can also rewrite the job's stored head: today any root session on this host (fact 5), until the head lives elsewhere;
- a holder of the prod env.

**Cost:** 4 to 5 days, including the chain and the off-DB head.

**Rollout risk: low.** It is additive, and prod has 0 approval requests (census 2026-10-08), so there is nothing to grandfather. The switch and rule history must start from a signed snapshot of the current rows.

### (e) Accept the risk

**State what is accepted:**
- an injection in a request can approve as anyone, exempt imports and bank payments, and switch enforcement off;
- today it can do anything at all as the owner.

That is defensible only if Hein judges the injection surface small (§1) and treats T1 and T2 as the larger exposure.

**Migration:** none.

**Cost:** zero.

**What it keeps:** PR B is still worth shipping, because T5 is real; the R-035 rounds found it repeatedly.

### (f) Make the switch and rule tables definer-written (T6)

- **(f1) Prevent.**
  - `REVOKE INSERT, UPDATE, DELETE` on `approval_enforcement` and `approval_rules` from `app_user`, `PUBLIC` and `platform_admin` (and TRUNCATE/TRIGGER from `migration_admin`).
  - Writes go through definer functions that re-check in SQL what `approvalRuleGuards.ts` and the disable path check today: `assertMayDemand`, `assertMayEditRule`, and the rank needed to disable. They also write the audit row in the same function.
  - The actor comes from (b)'s binding, so (f1) is as strong as that anchor: (b+a) for T3, any variant for T5.
- **(f2) Detect.** A definer trigger appends every change to an append-only log that `app_user` cannot write. (d) signs and verifies the history. It needs no anchor.

**Migration (f1):** the definer functions, the REVOKEs, and `approvalService.ts` calling the functions. The golden paths write no rules or switches, but `isaflow_dev` must have the functions before code that calls them runs there (§8). Reversible: re-GRANT.

**Migration (f2):** a trigger and a log table, under the protected-object rule. Additive.

**Closes:**
- (f1): T6 for T5, and for T3 as far as the anchor holds; T4b once `platform_admin` is revoked.
- (f2) with (d): detection of T6 by anyone without the key.

**Does not close:** T1, T2.

**Cost:** (f1) 2 to 3 days; (f2) 1 day on top of (d).

**Rollout risk: medium.** The rules UI (PR A) and the enforcement API must move to the functions in the same release.

## 5. Recommendation

1. **First, and not an N3 option: get prod access out of the worktrees and the agent sessions.** This matters more than everything below, because T1 and T2 need only a file read.
   - Give dev its own DB roles, with `CONNECT` on `isaflow_dev` only. Run `REVOKE CONNECT ON DATABASE isaflow FROM PUBLIC` and grant it back to prod roles only.
   - Give dev its own GoTrue and JWT secret.
   - Remove agent sessions' passwordless sudo and docker access.
   - Rotate the prod `postgres`, `platform_admin` and `migration_admin` passwords and the JWT secret.
   - The rotation is about 1 day plus Hein's ops time. The sudo and docker change is Hein's call. It touches prod (§8).
2. **P0-i plus P0-iv.** 2 to 3 days.
   - Until both ship, PR B's text should say it stops bugs, not injection.
   - P0-iii later, if T4 is worth the grant upkeep.
3. **(d) with (f2): signed decisions, exemptions and configuration.** 5 to 6 days.
   - It moves ahead of (b) because it depends on no database anchor and covers T6.
   - Against T1 it is worth something only after item 1.
4. **(f1), with (b+a) as the identity source for PR B's functions and for (f1).** 7 to 10 days in all. (b) without credential verification is not worth shipping alone: after P0-iv it still falls to whole-statement injection. It lands as a follow-up migration after B merges, so B ships as planned.
5. **(c2) for the exemption GUC**, on the (b+a) binding. 2 to 3 days. §8, because it touches live SI enforcement.
6. **Reject (a) as a per-call check.** Its verifiers live on inside (b+a), run once per transaction.

**Total for items 2 to 5:** about 16 to 22 working days: (2 to 3) + (5 to 6) + (7 to 10) + (2 to 3), as separate PRs in that order. Each one is mutation-verified the way PR B is: run the attack as the attacker would, watch it succeed before and fail after.

**Strongest argument against:** while item 1 is open, items 2 to 5 harden the doors that need a bug to open, while the ones that need only a file read stay open. If Hein will not do item 1, item 3 is the only one with value against T1, and only partially.

## 6. Questions for Hein

1. **Item 1.** May dev get its own DB roles and its own GoTrue and JWT secret? May the prod passwords and secret then be rotated, and agent sessions lose passwordless sudo and docker?
   - **Recommended:** yes to all. Without it, every worktree and agent session holds prod owner access and can mint prod sessions.
2. **Confirm the prod facts**, read-only, with the prod `DATABASE_URL`:
   ```sql
   SELECT current_user, r.rolsuper, r.rolbypassrls, r.rolcreaterole,
          pg_has_role(current_user, 'migration_admin', 'member') AS in_migration_admin,
          (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.approval_requests'::regclass) AS approval_requests_owner,
          has_database_privilege('postgres', 'isaflow', 'CONNECT') AS postgres_may_connect,
          has_database_privilege('postgres', 'isaflow_dev', 'CONNECT') AS postgres_may_connect_dev
   FROM pg_roles r WHERE r.rolname = current_user;
   ```
   - `has_database_privilege` covers grants, not `pg_hba`. `SELECT * FROM pg_hba_file_rules` answers the per-database question, but it needs a superuser.
   - §0.1 assumes `postgres`: not a superuser, BYPASSRLS, the owner.
3. **The P0 shape.**
   - **Recommended:** P0-i (`isaflow_web` plus `APP_DATABASE_URL`) and P0-iv (extended protocol on request connections) now; P0-iii later.
   - Each is a prod env or role change.
4. **PR B's scope.**
   - **Recommended:** B's REVOKE also covers `platform_admin` (INSERT/UPDATE/DELETE) and `migration_admin` (including TRUNCATE and TRIGGER) (fact 6).
   - `sageMigrationCommitService` writes no requests today, so nothing breaks.
5. **(b+a):** accept one small write per request, GETs included, and `JWT_SECRET` plus `EXTENSION_SIGNING_KEY` stored in the DB (so in backups)?
   - **Recommended:** yes, but only after item 1, so that the DB is no longer the widest-held place for them.
6. **(c2):** it changes how live supplier-invoice enforcement honours the import exemption, with identical outcomes intended.
   - **Recommended:** go, after (b+a), with the 712 suites unchanged as the proof.
7. **(d)/(f2):** add the MAC key (prod env only), the gate check and the nightly walk? Where should alerts go?
   - **Recommended:** yes, and Telegram, because the walk's findings need a person.
8. **The `aal2` shortcut** (`gotrue.ts:66`) accepts a correctly signed aal2 token without asking GoTrue.
   - **Recommended:** always confirm with GoTrue (one call per request), at least until the secret is rotated and dev has its own.
9. **(f1):** move the rules UI and the enforcement API onto definer functions?
   - **Recommended:** yes, with (b+a), because it closes T6 for bugs and is the only prevention for it.

## 7. Not verified

- **Prod:** the login role's attributes, the schema owner, `pg_hba` (Q2), and whether the worktree credential reaches `isaflow`. That last one rests on the memory note.
- **The prod image:** whether it ships `pgjwt`, Vault or pgsodium.
- **The injection surface:** the 160 raw-SQL call sites, and whether any of them sends several statements on purpose (P0-iv's census).
- **Other GUCs RLS trusts**, the same class as `request.jwt.claims`: `app.current_company_id` (WITH CHECK) and `app.invite_token` (`withInviteToken.ts:62`).

## Note from the 872 production fix (2026-10-09)

Migration 872's assertions exempt only `session_user` (the role applying it) when it inherits the owner of
`approval_requests` or `app_user`; any OTHER member of either refuses the migration, loudly. A request-pool role
that is a member of `app_user` must therefore be created AFTER 872 has applied — a from-scratch replay (DR restore,
a CI or fixture cluster) on which such a role already exists will see 872 refuse until it is created later or
temporarily removed from `app_user`. The N1 catalogue test (`tests/integration/r035-n1-catalog.int.test.ts`, OTHERS)
applies the same rule, so when N3 lands its pool role must be allowed there too, or the writer check reports it on
every database where it exists (dev and CI included).

