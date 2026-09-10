# Platform import persisted approval PostgreSQL evidence

Owner: platform_approval_pg. Exact base: ae8e5542d. Owned files are platformImportApproval.int.test.ts and platformImportApprovalFixture.ts under tests/integration/controls, plus this document. Root owns all implementation and migration 674.

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
