# R-035 N3 design spike: caller-set claims and the exemption GUC

A design, not a build. Nothing here has been implemented.

**Sources:**
- the code at `origin/master` `e0b15ae60`;
- the catalog of the disposable fixture `isaflow_schema_fixture` (read-only `pg_catalog` queries);
- a throwaway PG16 cluster in my scratchpad, which was deleted afterwards;
- the host's systemd units and `docker inspect` (secrets masked).

I did not connect to prod `isaflow` or to `isaflow_dev`. Where a claim depends on prod, it says so and §7 gives the SQL for Hein to run.

## 0. Facts that change the plan

1. **SQL injection in a request does not run "as app_user". It runs as the login role.**
   - `withAuth` connects with `DATABASE_URL` (`authPool.ts:24-27`) and then runs `SET LOCAL ROLE app_user` (`withAuth.ts:102`).
   - A single injected expression, `set_config('role','none',true)`, undoes that. Proven on the scratch cluster: `current_user` went from `app_user` back to the login role, and an UPDATE that `app_user` was refused then succeeded.
   - The login role is the schema owner. Prod migrations run with the same `DATABASE_URL` (`scripts/deploy.sh:144-146`, `apply-migrations.ts:150`). The deploy notes say that role is `postgres`: not a superuser, but BYPASSRLS and a member of `migration_admin`.
   - **Superuser or not.** On the fixture (and in any stock-docker CI database) the login role `postgres` is a superuser (`pg_roles.rolsuper = t`), so there the escape gives a superuser. A superuser can read server files, run `COPY … PROGRAM` (a shell inside the DB container) and bypass every trigger with `session_replication_role`. On prod the deploy notes say `postgres` is not a superuser. The escape still gives the schema owner, who can `ALTER TABLE … DISABLE TRIGGER`, `CREATE OR REPLACE` any definer function and write any row past RLS. Either way, the outcome for approvals is the same.
   - So today an injection gets the owner, or a superuser. PR B's REVOKE and every SECURITY DEFINER check stop application bugs. They do not stop an attacker until §3 (P0) is done. This matters more than caller-set claims or the exemption GUC.
2. **The login credential is in every worktree.**
   - `isaflow_dev` and `isaflow` are two databases on one cluster (port 7772), and Postgres roles belong to the cluster, not to a database.
   - So the `postgres` user and password in `.env.local` (12 worktree copies, mode 0640, group `gha-isaflow`) are prod's owner credential, unless `pg_hba` restricts by database. A reviewer has already reached prod this way (memory "Database targets").
   - The same holds for `MIGRATION_ADMIN_DATABASE_URL` and `PLATFORM_ADMIN_DATABASE_URL` in that file.
3. **The GoTrue signing secret is shared between dev and prod, and it is also in every worktree.**
   - The SHA-256 of `JWT_SECRET` in the workspace `.env.local` equals the SHA-256 of `GOTRUE_JWT_SECRET` in the `isaflow-supabase-auth` container. I compared digests only; no value was recorded.
   - The app accepts any HS256 token signed with it (`gotrue.ts:50-56`). A token that claims `aal: 'aal2'` is accepted without asking GoTrue at all (`gotrue.ts:66`).
   - So whoever holds that file can mint a prod session for any user over HTTP, with no SQL. Option (a) below adds nothing against such a holder.
4. **`platform_admin` can write `approval_requests` directly.** On the fixture it holds INSERT, UPDATE and DELETE (`information_schema.role_table_grants`). It is BYPASSRLS, and the insert guard waves BYPASSRLS roles through (`869_manual_journal_approval_enforcement.sql:488-492`). PR B must revoke from it too, or a platform-admin path can forge an approval.
5. **The two GUCs the controls trust are ordinary settings.**
   - `request.jwt.claims` is what `auth.uid()` reads (`348_rls_and_auth_helpers.sql:51-54`).
   - `isaflow.approval_gate_exempt` is the import and bank-feed exemption.
   - Any session can `set_config` either one. Proven on the scratch cluster as `app_user`.

## 1. Threat model

| # | Actor | What they can do today | Evidence |
|---|---|---|---|
| T1 | Holder of the DB login credential: the prod app process; `deploy.sh` via sudo; every worktree's `.env.local` (fact 2); the `docker` group, which is root-equivalent and lets you `docker exec` into `isaflow-supabase-db` (user `hein` and every agent session are members) | Anything, as the owner. They can disable triggers, replace definer functions, read any table and write approved rows. | fixture: `postgres` owns `approval_requests`, and FORCE RLS is on but the role is BYPASSRLS; deploy notes for prod |
| T2 | Holder of `JWT_SECRET`: the same files, the GoTrue container and the prod env | Mint an aal2 token for any user and use the real app as them. Every TS and SQL check sees a legitimate user. | `gotrue.ts:66`, `gotrue.ts:192-206` (the app mints tokens itself) |
| T3 | SQL injection inside a request transaction (`withAuth`, `bearerPipeline`, `withExtensionToken`, `withInviteToken`, `switch-company`) | **Today:** escalate to T1 through the role escape (fact 1). **After P0:** whatever `app_user` can do, under any identity they like: forge `request.jwt.claims`, set the exemption GUC, and read every tenant through RLS (which keys on the forged `sub`). | `withAuth.ts:101-104`, `bearerPipeline.ts:134-142`, `withExtensionToken.ts:102-106`, `withInviteToken.ts:58-59`, `switch-company.ts:26-27` |
| T4 | SQL injection in an owner-pool path: bare `sql` outside ALS, `withAlsTransaction`, `withPublicRouteTransaction` (Paystack webhook, portal verify), the 13+ cron routes, the `afterCommit` work | T1 directly. These paths run as the owner with no claims at all. | `neon/pool.ts:20,40`, `alsTransaction.ts:38-41`, `publicRouteTx.ts:16-21` |
| T4b | SQL injection in a `withPlatformAdmin` handler | `platform_admin`: BYPASSRLS, with DML on `approval_requests` (fact 4) | `withPlatformAdmin.ts:120-130` |
| T5 | An application bug: a mis-wired path, or a write that forgets a check | Writes the wrong row with the right claims | the class PR B's SQL re-checks are aimed at |

**How large is the injection surface?** `sql` is a parameterised template, so injection needs one of the 153 `sql.unsafe(` / `sql.query(` call sites, or one of the 7 `client.query(\`…${…}\`)` sites, to interpolate input. I did not audit them.

**Plainly:** the database cannot tell the app from an attacker who runs SQL in the app's transaction.
- `auth.uid()` returns whatever `request.jwt.claims` says, and any statement can rewrite that.
- PR B's definer functions take the actor from `auth.uid()` (goal §4). An injection therefore approves as anyone it names, provided it also survives every other SQL check: rank, author, requester and digest.
- The same forgery defeats the Login-as refusal.
  - `assertNotImpersonating` (`approvalDocuments.ts:205`) reads `session_id` out of the same GUC (`impersonationSessions.ts:53-61`).
  - It refuses only when that GUC reads `'impersonation'`. An absent or random `session_id` passes (`impersonationGuard.ts:35-36`).
- Against T1 and T2 nothing in the database helps. Against T3 nothing helps until P0 is done.

## 2. The exemption GUC

**Readers:**
- the supplier-invoice backstop (`712_…:142`) and the customer-invoice backstop (`865_…:346`) skip on `'import'`;
- the supplier-payment backstop skips an INSERT on `'bank_feed'` (`867_…:491-492`).

**Setters:** only the two TS wrappers (`approvalGateExempt.ts:89-94`, `:121-126`), pinned by `approvalGateExemptCensus.test.ts`. They have nine callers:
- import: `migrationApService.ts:234`, `migrationImportService.ts:154`, `sageCustomerImportService.ts:133`, `sageSupplierInvoiceImportService.ts:141`, `sageMigrationCommitService.ts:168` and `:276` (that last one runs on the `platform_admin` pool);
- bank feed: `provisionalInvoiceSettlement.ts:105`, `supplierAutoAllocate.ts:142`, `supplierBankPaymentService.ts:229`.

**What the SQL does not check:**
- **Rank:** the import exemption is honoured for an open bill only above a rank, but that rank check lives only in TS (`approvalGateExempt.ts:88`).
- **Provenance:** the bank-line check lives only in TS (`:120`).
- So a raw `SELECT set_config('isaflow.approval_gate_exempt','import',true)` followed by `UPDATE supplier_invoices SET status='approved'` passes the 712 backstop with no rank and no approval. The census pins who *should* set the GUC; it cannot stop anyone else.
- After PR B this is the cheapest bypass left for T3 and T5.

## 3. Prerequisite P0: make `app_user` a real boundary

None of (a) to (d) means anything against T3 while `set_config('role','none',true)` (or `RESET ROLE`, or `SET ROLE postgres`) lands on the owner.

**Why it happens.** `SET ROLE` changes only `current_user`. Any statement may switch back to the session user, or to any role the session user belongs to. That is documented Postgres behaviour, not a bug.

Every pool logs in with `DATABASE_URL`:
- `authPool.ts:24-27`, used by `withAuth`;
- `bearerPipeline.ts:46-60`;
- `withExtensionToken.ts:43-50`;
- `withPlatformAdmin.pools.ts:23-37`, the gate pool;
- the barrel `neon.ts:27` → `neon/pool.ts:20,40`, which is the owner pool behind every bare `sql`.

The same URL runs prod migrations (`deploy.sh:144-146`). So the request pools' session user is the DDL owner.

**What the fix needs.** A boundary holds only if the *session user* of a request connection has no more privilege than `app_user`. So the request pools must log in as a different role from the one that owns the schema and runs migrations. There are three shapes; they can be combined.

**(P0-i) A dedicated request login role.** Recommended.
- The role is `isaflow_web`: LOGIN, NOINHERIT, not a superuser, not BYPASSRLS, owning nothing, a member of `app_user` only.
- The request pools read a new `APP_DATABASE_URL`: `authPool`, `bearerPipeline`, `withExtensionToken`, `withInviteToken`, `switch-company` (`switch-company.ts:25-27` opens a `withTransaction` on the owner pool, then sets `SET LOCAL ROLE`; it would need the request pool) and `withPlatformAdmin`'s gate pool.
- `SET LOCAL ROLE app_user` stays, so policies and grants are unchanged.
- Proven on the scratch cluster: after the escape, `current_user` is `isaflow_web`, and the UPDATE `app_user` was refused stays refused.
- The owner pool and the `platform_admin` pool are unchanged.
- **Migrations are unaffected:** they keep running as the owner through `deploy.sh`, so no function owner changes, and the owner assertions in 712, 865 and 867 (`865_…:393`) still hold.

**(P0-ii) Log in directly as `app_user`.** Give `app_user` LOGIN and a password; `SET LOCAL ROLE` becomes a no-op.
- The escape then lands on `app_user` itself, which is equally safe, and it needs no new role.
- The cost is that `app_user` becomes a credential: it is in the env file, and it is the role every RLS policy names.
- It also changes the 348 role design (`app_user` was NOLOGIN on purpose) and the checks that expect it (e.g. memory "RLS + JWT": NOLOGIN). It is slightly cheaper than P0-i, with the same closure.

**(P0-iii) A non-owner role for the owner pool.** This shrinks T4.
- Bare `sql`, cron, public routes and `afterCommit` need BYPASSRLS, but they do not need ownership.
- An `isaflow_jobs` role (LOGIN, BYPASSRLS, DML grants only, owning nothing) cannot disable triggers or replace definer functions, so the backstops still bind it.
- The migration runner moves to its own URL. Either `MIGRATION_ADMIN_DATABASE_URL`, which exists in `.env.local` today, or the owner URL, kept out of the runtime env.
- **Cost:** grants on every table plus `ALTER DEFAULT PRIVILEGES`, and every future migration must grant to it. A missed grant 500s a cron or a webhook. The schema-drift audit would need a grant check.
- This is the larger change, about 2 to 3 days with high rollout care. It also means PR B's REVOKE must name `isaflow_jobs`.

**If the prod login role is a superuser after all (Q2):** P0-i or P0-ii is urgent rather than desirable, because the escape then reaches the DB container's shell.

**Cost of P0-i:** about 1 to 2 days. That includes a real-PG test that runs the escape as each request wrapper and asserts that `current_user` after `set_config('role','none',true)` holds no write privilege on `approval_requests` and is not BYPASSRLS. The mutation: point the pool back at `DATABASE_URL` and watch the test go red.

**Rollout risk of P0-i: low to medium.**
- Inside these transactions every statement already runs as `app_user`. Only `BEGIN`, and anything run before `SET LOCAL ROLE`, changes role.
- No code issues `RESET ROLE` or `set_config('role', …)` (`git grep` returns nothing).
- The real risk is a request path that silently takes an owner-pool connection inside a request and relies on it. It keeps working, and it stays T4.
- CI and the fixtures need the new role created; the integration helpers log in as `postgres` today.
- It needs a prod env change and a new role, so it is a §8 gate.

**What P0 closes:** T3's escalation to T1 (P0-i, P0-ii); T4's ability to disable the backstops (P0-iii).

**What it does not close:** T1, T2, T4b; T4's BYPASSRLS writes; or T3 forging identity *within* `app_user`, which is §4.

## 4. Options

### (a) Verify a signed token inside the definer functions

**Shape:** the app passes the raw token. A definer function verifies HS256 with a secret held in a table only the definer owner can read, and takes `sub` from the verified token instead of from the GUC.

**Facts:**
- GoTrue signs HS256: the container sets no `GOTRUE_JWT_ALGORITHM` or `GOTRUE_JWT_KEYS`, and the app verifies HS256 only (`gotrue.ts:56`).
- `pgjwt` is not on the fixture, and I could not check the prod `supabase/postgres:15.8.1.085` image. `pgcrypto` 1.3 is installed, and `hmac(…,'sha256')` works. A verifier is about 40 lines of plpgsql: base64url via `translate`, a constant-shape compare, `exp` and `aud` checks.
- **Paths with no GoTrue token:**
  - PAT and OAuth bearer calls carry synthesized claims (`bearerPipeline.ts:140`). Their tokens are stored as SHA-256 (`personalAccessTokens.ts:45,57`, `oauth.ts:41-42,253`), so SQL can verify them with `digest()`.
  - The browser extension signs with a second secret, `EXTENSION_SIGNING_KEY` (`extensionJwt.ts:43,88`), and synthesizes claims too (`withExtensionToken.ts:105-106`).
  - Print tokens use `PRINT_TOKEN_SECRET` (`printAuth.ts:77`), but they authorise GET only.
  - The cron, public-route and `withAlsTransaction` paths have no principal at all. Today none of them raises or decides an approval: every raiser is a `withAuth` route (`capture/[id]/post.ts:299`, `ai-invoice-pipeline.ts:295`, `recurring-invoices-run.ts:149`, `recurring-transactions-execute.ts:78`, `recurring-invoices-action.ts:64`).
  - So (a) means three verifiers in SQL and two secrets copied into the DB.
- **Expiry:** `GOTRUE_JWT_EXP=3600`. If every function call verifies, a long import that starts near the end of a token's life fails halfway through. Verifying once per transaction avoids that, which is (b)'s shape anyway.
- **Impersonation:** the definer can look up the verified token's `session_id` in `impersonation_sessions` itself. That fixes the forgeable refusal from §1.
- **Replay:** an injection can reuse its own request's token, so it can act only as itself. Other users' access tokens are not stored in `isaflow`; GoTrue's tables live in the cluster's `postgres` database (`GOTRUE_DB_DATABASE_URL`).

**Closes:** T3 (after P0) acting as someone else; T5 mis-binding a user.

**Does not close:**
- T1, who reads the secret table as owner;
- T2, who holds the secret, and that today means every worktree (fact 3);
- T4.

**Cost:** 4 to 6 days.

**Rollout risk: medium.**
- Every request write takes a token argument.
- Rotating the secret needs a DB update in lock-step with GoTrue, and a missed rotation 500s every approval.

### (b) A request binding table, written once per transaction by a definer function

**Shape:**
- An UNLOGGED table, owned by the definer owner, keyed by backend pid. Each row holds the transaction start (`now()`), the user, the company, the auth method and an impersonation flag.
- Every wrapper calls `isaflow_bind_request(...)` right after `BEGIN`, in the same round trip as the existing `set_config`s (`withAuth.ts:103-104` and its five siblings).
- **First writer wins:** a second bind in the same transaction raises. An injection runs after the bind and cannot open a new transaction from inside a statement, so it cannot rebind.
- PR B's functions and (c)'s exemption read the actor from a definer `request_actor()` instead of `auth.uid()`.
- They also compare the two. A mismatch is something only an attacker or a bug produces, so it should both refuse and alert.
- An unbound context (owner pool, cron, public routes) gets NULL and is refused, which is safe because no such path raises or decides (see (a)).
- Proven on the scratch cluster:
  - after the role escape, a rebind as another user is refused;
  - a forged `request.jwt.claims` leaves `request_actor()` at the bound user.

**Closes:** T3 (after P0) acting as another user, or dropping the impersonation flag; and T5's forged-actor bugs. The trust anchor is the TS verification each wrapper already does.

**Does not close:**
- T1, T2, T4, T4b (T4b binds as itself through `withPlatformAdmin`);
- a new wrapper that forgets to bind. A census test must pin every `SET LOCAL ROLE app_user` site to a bind;
- an injection acting as *its own* user. That is what the existing rank, author and requester checks are for.

**Cost:** 2 to 3 days, plus the mutation table.

**Runtime cost:**
- one extra function call per request, in an existing round trip;
- one UPDATE per request, GETs included. That allocates an XID per request. At this traffic it is noise next to the 200M freeze horizon, but it is a write on every read.

**Rollout risk: low.**
- It is additive until PR B's functions switch to `request_actor()`.
- After the switch, any request path that writes approvals without binding refuses: a 500, fail closed.

### (c) Move the exemptions into definer functions and drop the GUC

**(c1) Move the nine exempt writes themselves into definer posting functions.** Rejected.
- The Sage imports and the commit write wide, column-heavy rows.
- That is a rewrite of the importers, with a large behaviour-drift risk.

**(c2) Keep the TS writes, but replace the GUC with a definer-issued exemption bound to the transaction.** This reuses (b)'s binding.
- `approval_gate_exempt_begin(company, 'import', open)` re-checks the rank in SQL against the bound actor. The SQL already exists: `approval_rule_strictest_rank` from 865.
- `approval_gate_exempt_begin(company, 'bank_feed', bank_tx_id)` re-checks the line's provenance (`bank_feed_connection_id` or `import_batch_id`) and records the line id.
- The three triggers check for a live exemption row for the transaction instead of the GUC. The 867 check should also require that the payment row is the one the exemption names, if the payment carries its bank line; that needs checking.
- The two TS wrappers call `…_begin` and `…_end` in place of `set_config`, so the nine callers do not change.

**Closes:** setting the GUC by hand (T3 after P0, and T5); an import below the required rank; claiming the bank-feed exemption for a hand-keyed line.

**Does not close:** T1, T2, T4. And without (b) it has no trustworthy actor.

**Cost:** 2 to 3 days on top of (b).

**Rollout risk: medium, and a §8 gate.**
- It changes how the live supplier-invoice backstop (712) decides. Outcomes must be identical for every legitimate import.
- `withPlatformAdmin`'s Sage commit must bind before calling it.

### (d) Detect rather than prevent

**The naive form is not buildable.** An audit trigger cannot tell a decision "with no matching app session" from one with a session, for the same reason as the whole problem: the database has no app-only fact to compare against. It would also need (b).

**A buildable form: app-signed decisions.**
- When the TS decide path and the exemption wrappers act, they record an HMAC over the request id, decision, actor, digest and time. The record goes in the request row, and in an exemption log for each exempt write.
- The key exists only in the prod env (`/home/velo/isaflow/.env.local`, 0600 `velo`). It is not in the workspace and not in the DB.
- The TS gate (`assertApprovalCleared`) refuses an approval whose MAC is missing or wrong. That is prevention for every posting that goes through the app.
- A nightly job, run off the DB, walks every **document** that entered a population under enforcement. It alerts when the document has neither a validly MAC'd approval nor a MAC'd exemption.
- Walking documents, not requests, matters: it catches an attacker who posts and deletes the forged request.

**Closes or detects:**
- T1 through the leaked dev or worktree credentials (they cannot compute the MAC);
- T3, with or without P0;
- T4;
- T5.

**Does not close:**
- raw-SQL posting that bypasses the TS gate entirely. The DB backstop cannot see the MAC, so that is detected the next morning, not prevented;
- a holder of the prod env, who has the key.

**Cost:** 2 to 3 days.

**Rollout risk: low.**
- It is additive.
- Approvals that existed before it carry no MAC. Prod has 0 approval requests (census 2026-10-08), so there is nothing to grandfather.

### (e) Accept the risk

**State what is accepted:**
- an injection in a request transaction can approve as anyone, and can exempt imports and bank payments;
- today it can do anything at all as the owner.

That is defensible only if Hein judges the injection surface small (§1) and accepts that T1 and T2 are the larger exposure in any case.

**Cost:** zero.

**What it does close:** PR B stays worth shipping, because T5 is real; the R-035 rounds found it repeatedly.

## 5. Recommendation

1. **First, and not an N3 option: stop prod credentials living in every worktree.** This shrinks T1 and T2 more than everything below combined.
   - Give dev its own roles, with `CONNECT` on `isaflow_dev` only. Run `REVOKE CONNECT ON DATABASE isaflow FROM PUBLIC` and grant it back to prod roles only.
   - Give dev its own GoTrue JWT secret, which means its own GoTrue.
   - Then rotate prod's `postgres`, `platform_admin` and `migration_admin` passwords and the JWT secret.
   - Effort: about 1 day, plus Hein's ops time. It touches prod (§8).
2. **P0-i (§3): a dedicated non-owner, NOINHERIT request login role.** 1 to 2 days.
   - This is the precondition for PR B to claim anything against an attacker.
   - Until it ships, B's PR text should say it stops bugs, not injection.
   - Do P0-iii later, if T4 matters enough to pay for the grant upkeep.
3. **(b) as the identity source for PR B's functions**, applied by a follow-up migration once B has merged, so that B ships as planned. 2 to 3 days.
4. **(c2) for the exemption GUC.** 2 to 3 days. A §8 gate, because it touches live SI enforcement.
5. **(d) app-signed decisions.** 2 to 3 days. It is the only option that also catches a leaked owner credential. It can come before (b) and (c2) if Hein wants the cheapest real gain first.
6. **Reject (a).** Over (b) it adds protection only against a wrapper binding the wrong user. It costs three SQL verifiers and two secrets copied into a DB whose owner credential is the widest-held secret on the box.

**Total for items 2 to 5:** about 8 to 11 working days, built as separate PRs in that order. Each is mutation-verified the way PR B is: run the forgery as the attacker would, watch it succeed before and fail after.

**Strongest argument against:** while T1 and T2 stay open (that is, until item 1 is done), items 2 to 4 harden the one door that needs a bug to open, while two doors that need only a file read stay open.

## 6. Questions for Hein

1. **Credential split (item 1):** may dev get its own DB roles and its own GoTrue (or at least its own JWT secret), followed by rotation of the prod passwords and secret? Without this, every worktree and agent session holds prod owner access and can mint prod sessions.
2. **Login role:** please confirm the prod login role by running, read-only, `SELECT current_user, r.rolsuper, r.rolbypassrls, pg_has_role(current_user,'migration_admin','member') FROM pg_roles r WHERE r.rolname = current_user;` with the prod `DATABASE_URL`. §0.1 assumes it is `postgres`: not a superuser, BYPASSRLS, and the schema owner.
3. **P0:** which shape?
   - P0-i: a new `isaflow_web` login role, plus `APP_DATABASE_URL` for the request pools. Recommended.
   - P0-ii: give `app_user` LOGIN.

   Also, P0-iii (a non-owner `isaflow_jobs` role for the owner pool, with migrations on their own URL): now, later, or never? Each is a prod env and role change.
4. **PR B scope:** should B's REVOKE also cover `platform_admin` and `migration_admin`? Both hold DML on `approval_requests`, and the insert guard lets BYPASSRLS roles through (fact 4). Recommended: yes for `platform_admin`. Then `sageMigrationCommitService` must use the functions, and it writes no requests today.
5. **(b):** do you accept one small write per request, GETs included, as the price of a binding an injection cannot rewrite?
6. **(c2):** it changes how the live supplier-invoice backstop honours the import exemption, with identical outcomes intended. Go or no-go?
7. **(d):** do you want the MAC key, the gate check and the nightly document walk? Where should alerts go: Telegram, or Bugsink?
8. **The `aal2` shortcut** (`gotrue.ts:66`) accepts any correctly signed aal2 token without asking GoTrue. Keep it once the secret is rotated, or always confirm with GoTrue?
9. **The docker group:** user `hein`, and so every agent session on this box, is in `docker`. That gives superuser on the prod DB through `docker exec`. Is that accepted?

## 7. Not verified

- **The prod login role's attributes and `pg_hba`.** That needs a prod query (Q2). Whether the worktree credential connects to `isaflow` rests on the memory note, not on my own test.
- **Whether the prod image ships `pgjwt` or Vault.** That only matters for (a).
- **The 160 raw-SQL call sites.** I counted them; I did not audit them for injection.
- **Whether `supplier_payments` records its bank line,** which (c2)'s narrowing needs.
- **Other GUCs that RLS trusts.** These are the same class and are not covered here: `app.current_company_id` (WITH CHECK), and `app.invite_token` (`withInviteToken.ts:62`).
