# Platform import persisted approval PostgreSQL evidence

Owner: platform_approval_pg. Exact base: ae8e5542d. Owned files are platformImportApproval.int.test.ts and platformImportApprovalFixture.ts under tests/integration/controls, plus this document. Root owns all implementation and migration 675 (the file is 675_platform_import_approval_authority.sql; earlier drafts of this note said 674).

The fixture uses validated disposable PostgreSQL, a real platform_admin transaction and privately issued platform-import context. The maker is an active global administrator with zero tenant memberships. Reviewer transactions use actual app_user and existing member-cookie service authority. This suite does not test HTTP authentication or browser rendering; A1 actual middleware evidence is separate, and final admin REST/UI lifecycle remains required.

File-level scenarios: retain exact normalized synthetic CSV JSON original bytes; prepare full 2023 AR/AP groups; request persisted approval; independent current tenant administrator reviews; execute concurrently and retry with exact net 1000, VAT 150, gross 1150, one journal and document/effect; keep original period closed. Additional tests cover same-person member/token review, revoked maker/reviewer before effects and replay, changed account/source, mismatched retention/preparation target, and ordinary journal approval refusal.

Status: tests written first; actual PostgreSQL RED run queued behind root full CI. No pass or capability claim. The normalized upload is synthetic retained evidence, not authenticated Sage export provenance.

Additional tests committed in b6335a067: cross-import execution target, another import approval and missing approval, actual other-tenant source, and real PostgreSQL trigger failures on operation effects, committed-change events and protected evidence. Failure predicates bind the exact synthetic company and import through transaction-local GUCs. Tests catch the service failure, verify no journal/document/effect/event prefix commits and the independent approval remains usable for retry. All 13 cases still await the root PostgreSQL lease; these are test specifications, not results.

Repository warning during commit: auto-gc found an empty shared object at .git/objects/64/24759cd84a173086c695c9a3ada2ba4bab321a and failed repack. The test commit succeeded and named HEAD remains readable. Root was notified; no shared-object mutation or cleanup performed by this worker.


## Actual baseline RED

Exact test commit b259b4c4c, implementation base ae8e5542d. Root granted exclusive PostgreSQL lease after CI completed. Node 22.23.1, validated local fixture environment from the durable artifact directory, command:

```sh
bunx vitest run --config vitest.integration.config.ts --no-file-parallelism tests/integration/controls/platformImportApproval.int.test.ts
```

Terminal exit 1, session 10009, 2026-09-10 07:39:59 SAST: **11 failed, 2 passed, 13 total**, 1.06 seconds. Durable log: `.worktrees/mcp-forensic-artifacts-20260909/platform-import-approval-red.log`.

All eleven failures reach real `storeHistoricalImportSource` and fail at the existing `assertHistoricalImportAuthority` member-only guard: `Historical imports require authenticated member authority`. Fixture initialization and actual platform_admin role probe succeeded. This validates the capability gap; downstream approval/effect assertions have not executed yet. The wrong-hash refusal currently passes through the same broad member-only guard and is not independent proof of source confinement. Ordinary journal refusal passes under the fixed action permission ceiling. No monetary success, downstream adversarial pass, static gate or independent review is claimed. PostgreSQL lease released to root.


## Blind-review remediation and actual GREEN

Base c26475391. Node 22.23.1, the same validated local fixture environment, exclusive PostgreSQL
lease. Migration 675 was re-applied to the synthetic database twice after each edit and is
idempotent (single `control_historical_imports_requester_grant_shape` check afterwards).

Three findings were fixed, tests first, each with an actual RED and a mutation check:

- **Platform self-approval by impersonation (P1).** A super_admin could request his own historical
  import under platform authority, impersonate a tenant administrator and approve it as that
  member. `tests/integration/controls/impersonatedApprovalDecision.int.test.ts` drives the real
  route (`withAuth` -> `control-approvals` -> `decideOperationApproval`) with a real target session
  and the real delegation proof. RED at c26475391: three impersonated approvals returned HTTP 200
  (`platform-import-fix-p1-red.log`). GREEN after the fix, 4/4
  (`platform-import-fix-p1-green.log`). The control principal now carries the impersonating actor,
  derived from the proof and from the impersonation session recorded by the admin route, because
  the proof cookie can simply be dropped when the impersonated member has no verified MFA factor.
  Mutations `m1`-`m4` (drop the self-approval naming, disable the guard, drop the recorded-session
  source, drop the proof source) each turned the suite red.
- **Platform permission ceiling (P2).** The ceiling granted read:reports/read:invoices/read:accounts/
  read:contacts to every action on the BYPASSRLS platform client. Traced through the actual suites,
  the confined path uses only read:imports (not under retain), write:imports outside read,
  write:approvals for request and write:post for execute. RED: three real unconfined tenant readers
  resolved under a platform target (`platform-import-fix-p2-red.log`); GREEN afterwards
  (`platform-import-fix-p2-green.log`, 100 tests over 9 files). Mutations `m5` (broad ceiling) and
  `m6` (retain keeps read:imports) both went red.
- **Migration name-guess drop and unreached requester checks (P3).** RED
  (`platform-import-fix-p3-migration-red.log`): re-running 675 over a legacy grant-shape constraint
  under a different generated name left two constraints. GREEN after dropping by definition with an
  in-migration schema assertion. New cases reach the requester role checks - the TypeScript
  `platform_role` check directly, the SQL `grant_valid` computation (demoted maker who is also a
  tenant member) and the SQL authority filter (demoted maker who is not) - plus the review-time
  revoked-maker refusal on the member decide path. Mutations `m7`-`m10` each turned exactly the
  matching case red; `m11` (removing the self-approval check) turned the maker's own-session case
  red.

No production database was touched. Logs live in `.worktrees/mcp-forensic-artifacts-20260909/`
under `platform-import-fix-*.log`.


## Second blind review: sessions minted before the fix (P1), and the deploy step

The first fix covers sessions minted after it. A session minted BEFORE it carries neither signal -
the delegation proof is droppable and expires within the hour, and the recorded-session lookup keys
on `details->>'target_session_id'`, which no earlier `impersonation_start` row has. Because
end-impersonation never revoked the target's GoTrue session, those refresh tokens are live: refresh
a retained target token, present only the access and active-company cookies, and against a member
with no verified MFA factor withAuth admits the session at AAL1 with nothing marking it.

Fixed in code:

- **end-impersonation now revokes the session it minted** (`logout(accessToken,'local')` when the
  caller still holds the impersonated cookies - the member's own sessions survive - otherwise
  `adminRevokeAllUserSessions` for the target). It runs before the admin cookies are restored and
  returns 502 with the stash intact if GoTrue refuses, so the exit is retryable rather than leaving
  a live orphan session. Unit-proven in `mfa-impersonation-workflow.test.ts`; mutation `m12`
  (revocation removed) turns it red.

- **OPERATOR STEP, REQUIRED AT THE DEPLOY THAT SHIPS THIS:**

  ```sh
  bun scripts/revoke-legacy-impersonation-sessions.ts           # dry run: lists and counts targets
  bun scripts/revoke-legacy-impersonation-sessions.ts --apply   # revokes every listed target
  ```

  It revokes all GoTrue sessions of every user named by an `impersonation_start` row with no
  `target_session_id`. Those members are signed out and log in again; that is the point. It has NOT
  been run against production by this work - no production database was touched. Dry run, counts and
  failure reporting are unit-proven (`tests/unit/scripts/revokeLegacyImpersonationSessions.test.ts`,
  mutation `m14`).

- **Can such a session be detected instead of revoked? Honestly, no.** The impersonated session is
  an ordinary GoTrue session for the member, minted by a magic link. Nothing outside the audit row
  ties a session to an impersonation: the stash never stored the session id, GoTrue's session rows
  carry no impersonation marker, and the only correlates are creation time and a magic-link/OTP
  `amr` - which ordinary magic-link and administratively minted dev logins also produce. A
  timestamp heuristic would both miss sessions and sign out members who did nothing. Revocation is
  the remedy; there is no reliable detector.

Also in this round:

- **Unmigrated database (P2).** `withAuth` called the reader function unconditionally, so on a
  database that lags migration 675 every authenticated request would fail with 42883 - and a dev
  database here has lagged migrations before. The call is now guarded by `to_regprocedure` (result
  cached once present, one extra round trip per process). When the function is absent the state is
  reported as `IMPERSONATION_UNVERIFIED` and the review guards refuse outright. That is the
  deliberate trade: fail open for ordinary reads and writes, fail closed for anything that records a
  human review. Mutation `m13` (treating unverified as unimpersonated) turns it red.

- **Migration assertion (P3).** The auth-method check is still dropped by its deterministic
  column-level name, but the migration now asserts that exactly one such check survives and that it
  admits `platform_import`, and the grant-shape assertion no longer needs its second EXISTS.
  Mutation `m16` (a cookie-only auth-method check) turns the migration and its test red.

- **Real-route coverage (P3).** The control-exception guard is now proven through
  `pages/api/accounting/control-exceptions` under a real impersonated session, with the
  unimpersonated administrator's resolution succeeding in the same case. Mutation `m15` (guard
  removed) turns it red. The beneficiary guard remains unit-level only.

Suites after this round: integration 165 passed over 14 files
(`platform-import-fix-r2-int-green.log`), units under `tests/unit/{auth,scripts,services/controls}`
1372 passed (`platform-import-fix-r2-unit-green.log`). Migration 675 re-applied twice, exit 0 both
times.


## Third round: approver-of-record workflows outside the controls kernel

Five single-approver workflows recorded `approved_by` under an impersonated session and are now
guarded the same way the kernel is - supplier invoice, credit note, customer write-off, VAT
adjustment and expense claim approval. The guard sits at the very top of each entry point, before
any row is read or written: these routes answer 4xx and withAuth COMMITS a 4xx, so a refusal taken
after a partial write would persist that write. It reads the impersonating actor from the
authenticated request context because these services take a `userId`, not a principal; a caller
with no request context (script, background task) and any bearer/MCP caller is unaffected.

All five are proven through their own real routes with a real impersonated session
(`tests/integration/controls/impersonatedApproverOfRecord.int.test.ts`). Genuine RED: at
97c0e7ba3's parent every case failed with an unrelated validation message
(`platform-import-fix-r3-red.log`), which is why each assertion pins the refusal text - through the
exposed message where the route surfaces it, and through the development-only detail where the
route masks the cause - rather than the 400 alone. Mutations `m17`-`m22` (each guard removed, and
the commentary record removed) turn exactly the matching case red.

Commentary sign-off is deliberately not blocked: no ledger effect, and an administrator finishing a
client's report is legitimate support. Migration 676 adds
`report_commentary.approved_by_impersonator`; `approved_by` stays the member whose session signed
and the new column names the administrator who drove it (or the unverified marker when the state
could not be established). NULL means an ordinary sign-off. Applied twice to the synthetic
database, idempotent.

### Finding for later, not fixed in this pass

`expenseClaimService.approveClaim` has a self-approval hole independent of impersonation: it checks
only that the claim is `submitted` and never compares the approver with the employee or the
submitter, so a claimant with write access can approve their own claim. The other four sites are
single-approver by design too - none checks independence at all - so the impersonation guard closes
"an administrator approving as a member", not "the maker approving their own work". Segregation of
duties on these five paths is a separate piece of work.


## Fourth round: the proof outlived the impersonation, and the guard was a subset

**P1 - ending impersonation did not end it.** The delegation proof was stateless: signature,
issuer/audience, target binding, one hour. `verifyToken` returns as soon as it validates, so an
administrator who copied `sb-access-token` and `sb-impersonation-proof` out of the browser kept
authenticating as the member for the rest of that hour after clicking End Impersonation - the
MFA-enrolled population the proof exists for, i.e. round two closed the refresh path and left this
one. A proof now names the stash row it belongs to (`stashId` in the payload) and is honoured only
while that exact row lives and no `impersonation_end`/`impersonation_end_failed` entry names its
session. Ending impersonation deletes the stash, so the copied pair stops authenticating
immediately; every proof minted before this change names no stash and is refused outright. Proven
through actual withAuth in `impersonatedApprovalDecision.int.test.ts` (a live delegation lists
approvals; the same cookies 401 once the stash is deleted, and once an end is recorded). Mutation
`m23` (drop the liveness check) turns it red.

**The corollary, measured rather than assumed.** With the proof dropped and the access token kept,
acceptance falls to GoTrue `/user`. Against this deployment's GoTrue, on a disposable probe user:
sign in -> `GET /user` **200**; `POST /logout?scope=global` -> **204**; the same unexpired access
token then `GET /user` -> **403**, and the refresh token -> **400**. So a revoked session is
rejected here: `verifyToken`'s fallback throws on the non-2xx and the request is 401. That is a
property of this GoTrue version, not of our code - a deployment whose `/user` is stateless would
re-open the dropped-proof path, so it is worth re-measuring after a GoTrue upgrade.

**P2 - the unverified marker was breaking every approval on an unmigrated database.** The probe ran
after the proof lookup, which is null for ordinary sessions, so every cookie principal on a database
lagging migration 675 carried the marker and every guard refused - and it was being written into
`approved_by_impersonator` on ordinary sign-offs. A session with no impersonation signal at all is
now simply unimpersonated; the marker is reserved for a session a presented proof implicates but
cannot resolve. The constant moved to `src/lib/auth/impersonationState.ts` so the authenticated
request path no longer imports the accounting controls graph.

**P2 - the guarded set was hand-picked.** Enumerated by call site instead. Every entry point outside
the controls kernel that writes an approver column or posts a journal when it approves now refuses
an impersonated principal before it reads its row: customer invoice, payroll run, supplier payment
batch, accounting adjustment, supplier payment, practice time entries, leave decision, close-run
proposal and expense claim rejection, joining supplier invoice, credit note, write-off, VAT
adjustment and expense claim approval. `core/timeTrackingService.approveEntries` is the one approve
function deliberately left alone: it flips a status in bulk and records no approver. Each is covered
in `impersonatedApproverCensus.int.test.ts` with its unimpersonated twin proving the refusal is the
guard and not the lookup, and each guard was mutation-checked individually.

**P3s.** A request context with no tenant principal is no longer silently allowed: an open
global-administrator request (asked of the platform-import registry, not inferred from absence) is
refused as a non-independent reviewer. **This breaks `sageMigrationCommitService` at its
`approveSupplierInvoice` call under `withPlatformAdmin`** - a platform admin can no longer approve a
tenant's imported invoices in their own name. That path needs the confined historical-import
treatment; until then the migration commit stops at the approval step. End-impersonation records the
session it revoked and the scope, records an `impersonation_end_failed` row when GoTrue refuses (so
an outage cannot leave a live session with nothing on record), and returns a warning when the exit
had to revoke every session the member owns. Commentary records and projects the actor behind all
three decisions - `approved_by_impersonator`, `rejected_by_impersonator`, `withdrawn_by_impersonator`
(with `rejected_by`, which nothing recorded before), migration 676, applied twice, idempotent.

Suites: integration 211 passed over 16 files with one pre-existing failure in `apSharedWriters`
(identical case and assertion at base `c26475391`); units 10 927 passed with the five known
pre-existing failures. Logs `platform-import-fix-r4-*.log`.


## Fifth round: the gate's polarity, and the round-4 review

**The request-context guard now refuses by default.** It used to allow any request context without
a control principal unless it was positively a platform-admin request, so an auth path or ordering
bug that left the principal unset approved quietly. It now refuses every principal-less request
context. The only blanket allow is having no request context at all - a script or background task
run by an operator with database credentials - and that is stated in the code rather than implied.
Regression guard for the class: `independentRequestReview.test.ts` runs the guard inside a bare
`als.run` store; mutation `m34` (put the allow back) turns it red.

Every `als.run` in `src`, `pages` and `scripts` was enumerated. None needs an allow:

| Principal-less context | Where | Why it is not allowed through |
|---|---|---|
| Platform-admin request | `withPlatformImportRequest` | the one exception, below |
| Invite token | `withInviteToken` | registration/acceptance; records no approver |
| Extension token | `withExtensionToken` | bank-feed pairing and statement ingest; records no approver |
| MCP invocation persistence | `invocationPersistence.independently` | fixed internal SQL only; the tool itself runs under a bearer principal |
| Audit-worker poller and lease | `auditJobPoller`, `auditJobLease` | fixed SQL; job work runs under `withControlJobRequest`, which installs a job principal |
| Portfolio workbench | `portfolioWorkbenchService` | cross-company reads only |
| AP backfill operator script | `scripts/ap-backfill-supplier-payments.ts` | raw SQL functions only, no service calls |

Their own suites (MCP HTTP, audit worker, controls) still pass except for failures that also fail at
base or need fixture opt-ins not present here.

**The platform-admin exception, and why the suggested remedy does not apply.** Refusing it breaks
`sageMigrationCommitService`, which approves imported supplier invoices under `withPlatformAdmin` -
every AP invoice would fail into `summary.apInvoices.failed`. Routing that commit through
`withPlatformImportTarget` does not work: the target is keyed to a historical import or retained
source (there is none for a Sage commit), its permission ceiling grants no `write:invoices`, and its
confinement refuses every operation except `historical_import.post`. So the context is allowed and
logged at error level on every call, identified positively (module-private WeakSet keyed on store
identity, set only inside `withPlatformImportRequest`, removed in its `finally`). The census test and
the unit test both fail the day the refusal lands. **Open:** a platform administrator can still be
the approver of record on a tenant's supplier invoices through Sage migration, until that path is
given the confined treatment.

**Stated plainly: the platform-import exemption is total.** Anything reachable inside a
platform-import target context carries a control principal with no impersonator, so the
independence guard passes for it - including action `execute`. Confinement relabels the platform
administrator's approval authority to one operation and one import; it does not remove it. The
tenant approval requirement on `historical_import.post` is what stands between that administrator
and a posting, not this guard.

**End-impersonation records the impersonated session.** It took the session id from the caller's
claims, which on the global path are the administrator's restored session: the 502 path kept the
stash, so the proof stayed live, and the success record carried the wrong session under the name
`target_session_id`. It now reads the id from the `impersonation_start` record for its stash.
Covered on the target's exit, the administrator's exit and the 502 path; mutation `m35` red.

**The request path fails closed again when the reader is missing**, with the cost moved to deploy:
`scripts/assert-impersonation-reader.ts`, run by `deploy.sh` right after migrations, stops a deploy
whose database lacks `control_session_impersonator()`. Mutation `m36` red. `resolveImpersonatingActor`
is called from `withAuth` only - pinned by an architecture test - so an approver path reached outside
`withAuth` carries no impersonation marking; that is the stated invariant. Commentary refuses a
decision it cannot attribute rather than writing the unverified marker into an actor column
(`m37` red).

**Census, by approver-column write.** Added: AFS section review (`reviewed_by`), section sign-off
(`signed_off_by`), document sign-off and document lock (`locked_by`, two writers), the
caller-supplied reviewer/signatory fields of `updateAfsSection`, and both tax-directive approvals
(`approved_by`). Each mutation-checked.

**Migration 677** moves the delegation liveness reads behind a SECURITY DEFINER function (the
request path needs no grant on the stash table, which holds encrypted admin tokens, and a permission
failure can no longer read as an ended delegation) and adds a partial expression index for the
audit lookup. Applied repeatedly, idempotent. 677 was confirmed unused across every worktree and ref.

**Review points answered rather than changed.** `report_commentary`'s person columns are all
`text` (`approved_by`, `withdrawn_by`, `generated_by`), so the new actor columns force no cast.
Migration 676 was only ever applied to the synthetic fixture database, not to `isaflow_dev`; it is
frozen from here and later DDL goes into 677. `independentReview` now imports
`platformImportAuthority`, which itself imports the controls context: that joins an existing
context/platformImportAuthority cycle rather than creating a new one, and is not fixed here.


## Sixth round: the Sage exception was built on a false premise

**Correction.** Round five allowed the platform-admin request context because refusing it would
"break the Sage migration commit". That was wrong. Inside a platform-admin request,
`approveSupplierInvoice -> runApControlled -> requireApControl -> requireControlTx` already throws
*Authenticated control transaction required*, because that request has no control principal; the
census test's own note ("fails on something else entirely") was the evidence, misread. No Sage AP
invoice can be approved on that path today, and the AR half of the same route already fails every
invoice. So the exception protected nothing, its error-level log line claimed an approver of record
for saves that were rolled back - false forensic evidence - and it left plain-SQL approver writes
(AFS sign-off and lock, tax directives, leave, commentary) open to any future admin route. It is
removed: the platform-admin request is refused by name like every other principal-less context, and
the log line is gone with it. Proven on a guarded service that goes through requireControlTx and on
two plain-SQL AFS writers; mutation `m47` red in both suites.

**Follow-up, not a gate:** the Sage migration commit route needs its own confined design before it
can create or approve tenant invoices at all.

**Deploy gate widened.** It now checks that both `control_session_impersonator()` and
`impersonation_delegation_live(uuid,text,text,text)` exist AND that `app_user` has EXECUTE on each;
missing EXECUTE would make every authenticated request 500 while an existence check passed. The
missing-function and missing-grant failures are named apart (different remediation). `scripts/**` is
outside `tsconfig` and no CI step runs this gate, so its first real run is mid-deploy against
production; `tests/unit/scripts/assertImpersonationReader.test.ts` is the only thing exercising it
before then. Mutations `m48`-`m50` red.

**End before revoke.** A revocation that succeeded followed by a failed `impersonation_end` INSERT
left a revoked session with no end on record, whose still-valid access token kept passing the proof
branch for up to an hour. The end marker is now written before GoTrue is asked; if that INSERT fails
nothing has been revoked. Proven by a trigger that makes the INSERT fail: GoTrue is never called.
Mutation `m51` red. The admin-exits-and-GoTrue-fails case is added; it passes now and **fails on the
round-four code at 88f5aea0b** (zero `impersonation_end_failed` rows for the impersonated session),
which is the genuine RED the earlier target-cookie case could not give.

**Guards keyed on the transition.** The tax-directive approval and the AFS section update refuse on
`status = 'approved'` / `'reviewed'` / `'signed_off'`, not only when an approver id is passed.
Mutations `m52`, `m53` red.

**Migration 677's index is built without CONCURRENTLY.** `apply-migrations.ts` runs each file inside
`BEGIN`, where CONCURRENTLY is not allowed, so the build takes a SHARE lock on `admin_audit_log`:
production audit INSERTs (every admin action) block for the duration of the build. It is a partial
index over three impersonation actions, so the build is short, but it is not zero.

Suites: units 10 948 passed with the five known pre-existing failures; integration 240 passed over 16
files with the known `apSharedWriters` failure (identical at base).


## Seventh round

**An AFS section reached `reviewed` without a reviewer - pre-existing, open to the preparer.**
`restoreVersion` set every restored section to `reviewed` with no reviewer and no guard. Saving a
version and restoring it turned a pending mandatory section into a reviewed one, which passed
`countMandatorySectionsBelow('reviewed')` and unblocked submission and partner review. A restore now
never raises review state: a lower status is kept, and a reviewed or signed-off section drops to
`pending`, with the saved snapshot recording *"Restoring version N invalidated the section's prior
<status> review"*. An impersonated session may not make that change. Mutations `m54`-`m56` red.
Noted, not changed: `saveVersion` itself demotes `signed_off` to `reviewed` on every save.

**Management packs - reported, not changed.** With `reviewRequired` off (the default is on),
`managementPackGeneratorService` sets the pack's `afs_documents.status` to `signed_off` in plain SQL
and delivers it: no signatory, `locked_by` NULL. The product deliberately lets an internal management
pack go out unreviewed, so in that mode it is meant to be an unsigned document, and `signed_off`
misrepresents it. The right fix is a distinct status (for example `published`) that still locks the
document - a CHECK-constraint, `DocumentStatus` and UI change, and `assertDocumentEditable` must
treat it as locked. I chose not to make it in this pass because it changes a shared status
vocabulary outside the approval work; it is a recommended follow-up.

**Tax directive guard** keys on `status === 'approved' || approvedByUserId`, matching the AFS guard
(`m57`).

**The deploy gate checked the wrong role for liveness, and its comments were wrong.**
`impersonationDelegationLive` runs from `verifyToken` on the DATABASE_URL login role through the
pool, before any app_user transaction exists. The gate now checks EXECUTE for `current_user` on the
liveness function (it runs with the application's own DATABASE_URL) and for `app_user` on the
reader, which does run inside withAuth. The failure modes are now described correctly: a reader
missing EXECUTE makes withAuth throw (500); a liveness failure is caught, logged, and refuses the
proof - the MFA bypass for impersonated sessions switches off, fail-closed, not a 500. The catch was
silent before; it logs now. `m58` red.

**The gate always runs.** It executes on load (no argv check), and `deploy.sh` requires its success
line, so a renamed or wrapped invocation cannot pass having checked nothing (`m59`). The gate SQL now
runs against the fixture Postgres in `impersonationReaderGate.int.test.ts`: present-and-granted, each
function missing, app_user lacking EXECUTE, and a login role lacking EXECUTE on liveness - each in a
rolled-back transaction.

**End records say what happened.** The `impersonation_end` row, written before GoTrue is asked,
carries `revoked:false`; the revocation GoTrue actually performs is its own append-only
`impersonation_revoked` row with `revoked:true`; a failed exit leaves `_end` and `_end_failed`, both
`revoked:false`. Each retry adds another `_end`, but the flag keeps them honest (`m60`). The
insert-failure test now also shows the impersonation simply continues: stash intact, proof honoured,
no end row.

Suites: units 10 949 passed with the five known pre-existing failures; integration 251 passed over
18 files with the known `apSharedWriters` failure (identical at base).


## Eighth round, and where this branch stops

- **Restore race.** Whether a restore invalidates a review was decided from an unlocked read, so a
  review committing mid-restore left `reviewed` on the restored content. The first read now takes
  the row lock (`FOR UPDATE`), and the final UPDATE also decides in SQL
  (`CASE WHEN status IN ('reviewed','signed_off')`). An interleaving test holds a reviewer's
  uncommitted UPDATE while the restore starts, commits it, and requires `pending` plus the
  invalidation note; it was `reviewed` before (RED). Mutation `m61` (unlocked read) red. Mutation
  `m62` (SQL CASE reverted to the JavaScript decision) **survives**: under the row lock the two
  decisions are identical, and the SQL form only matters for a restore run outside any transaction,
  which no route does. It stays as belt-and-braces and is recorded as untested.
- **Revocation record cannot fail the exit.** The `impersonation_revoked` INSERT runs after GoTrue has
  revoked; if it threw, the exit 500'd with the admin's cookies unrestored and the stash kept, and a
  retry would loop on 502. It is audit-only (the end row already stopped the proof), so its failure
  is logged with identifying fields and the exit completes. Proven with a trigger that fails that
  INSERT: 200, stash deleted, end row present, proof refused. `m63` red.
- **Gate success line** now reads "executable by their calling roles", changed together with the
  line `deploy.sh` requires; verified by piping the real gate output against the fixture through the
  same grep. `m64` red.
- **677 checksum.** 677's comment was edited after it had been applied to the fixture database.
  The fixture is migrated by `psql -f`, not by `apply-migrations.ts`: its `schema_migrations` table
  has a `checksum` column but zero rows, so no checksum was ever recorded for 677 and nothing refuses
  it. 677 is not on master, so no other database has applied it. It is not edited again.

**Moved out of this branch:** the wider AFS review defects the last review found (the overrides
endpoint, AI-narrative accept, `updateAfsSection` content writes, and restore/overrides not being
bound to the URL's document) are pre-existing AFS module work, now on a separate branch.

## Final summary

What this branch changes, end to end:

1. **Platform historical imports** have a real maker/checker path: retain -> prepare -> request under
   confined platform authority, independent tenant approval, execute. The platform permission
   ceiling grants only what that confined path uses (no generic tenant reads). Migration 675.
2. **An impersonated session can never be an independent reviewer.** The control principal carries
   the impersonating actor, taken from the delegation proof and from the recorded impersonation
   session (so a dropped proof cookie does not hide it). Every controls-kernel decision, every
   approver-of-record writer found by call site and by approver-column write (supplier invoice,
   credit note, write-off, VAT adjustment, expense claim approve/reject, customer invoice, payroll
   run, payment batch, adjustment, supplier payment, practice time entries, leave, close-run
   proposal, AFS review/sign-off/lock and caller-supplied signatories, tax directives, AFS restore
   that would drop a review) refuses it. Commentary is recorded, not blocked. Migration 676.
3. **The review guard refuses by default** inside a request context: any context without a tenant
   principal is refused, including a verified platform-admin request. The only blanket allow is no
   request context at all (a script).
4. **Ending impersonation ends it.** The delegation proof names its stash row and is honoured only
   while that row lives and no end is recorded for its session (migration 677, SECURITY DEFINER,
   indexed). The end is recorded before GoTrue is asked to revoke, from the impersonation start record,
   never the caller; a failed revocation is recorded as `impersonation_end_failed`. A successful
   revocation is recorded as `impersonation_revoked` on a best-effort basis: if that INSERT fails the
   only record is a log line, and the end row still says `revoked:false`.
5. **Operational gates.** The deploy stops unless both reader functions exist and their calling roles
   may execute them. The pre-change population of impersonated sessions is handled by
   `scripts/revoke-legacy-impersonation-sessions.ts` - an operator step at deploy, dry-run first.

Open, and written down rather than fixed here: the platform-import exemption is total (confinement
relabels the platform administrator's approval authority rather than removing it); the Sage migration
commit needs a confined design; management packs use `signed_off` for an unsigned document; the
expense-claim self-approval hole; and the AFS module defects moved to their own branch.
