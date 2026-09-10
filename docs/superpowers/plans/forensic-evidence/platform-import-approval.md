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
