# Actual MCP audit delivery HTTP acceptance

Base7ee8037ed; invoice_evidence owns only new auditDelivery fixture/tests and this fileplan. Default source /api/mcp route through Next apiResolver on loopback; real PAT/bearer pipeline/private invocation receipts/current PostgreSQL app_user. No route/authority/job mocks. Explicit disposable database opt-in, synthetic journal and inline bank evidence only.

Cases: snapshot enqueue remains queued through status reads; cold runner then authenticated manifest/item/chunk reconstruction; export enqueue remains queued through status, actual poller executes and HTTP reconstructs every file and verifies signed manifest/original bytes despite later source mutation. Sameperson concurrent retry yields one job; samekey different people distinct jobs; current payroll revocation refuses cached same-key replay; foreign tenant reads refuse. Inspect actual invocation receipts and no duplicate publications. Resource lease required, all server/pools closed. No production builtNext/UI or production verification claim.

Tests authored first; actual HTTP acceptance pending. Any runtime discovery must be reported as confirmed only after reproduction; source fixes remain root-owned.

## Initial actual HTTP RED
- First fixture bootstrap had a parameter reused as UUID/text; explicitly cast synthetic journal ID/number before valid HTTP evidence.
-25802 terminal1: both actual default-route cases refused audit_snapshot with 'arguments use an unsupported tool schema'. Existing PAT/bearer/feature/invocation pipeline reached registry. Root independently identified unsupported schema keywords and owns correction. No bypass/mocks added.
- afterAll closed server, authPool, private invocation pool, general SQL pool and fixture pool; DB lease released. No lifecycle success claimed yet.

## Corrected actual HTTP result
- Root verified schema/company assertion correction2d15105c1+3d3f8f7fb cherry-picked17e3f7fa7+2a413238a. Matching company assertions added to both enqueue calls; no bypass.
-52878 ran corrected transport: authority scenario passed; lifecycle test initially asserted journal description outside the actual retained projection. Corrected fixture assertion to captured entry_date and compared the exact reconstructed journal record with exported snapshot after mutating live entry_date. This was a test assumption, not a source defect.
-44048 terminal0:2 scenarios,30 actual POST requests,21.02s. All8 audit delivery tools exercised; genuine PAT current authority, cold snapshot runner, server export poller, indexed record/evidence hashes, every export file hash and authenticated manifest, original attachment bytes after live mutation, no-work polling, concurrent retry one job, samekey different people, revoked payroll through another sameperson token before cached reply, committed refusal receipt, foreign tenant refusal. Re-running completed export returns not_claimed.
- All HTTP servers and auth/private invocation/general/fixture pools closed; DB lease released. No real financial transactions or external messages.
- Dedicated test TypeScript72383 terminal0: temporary config extends root, incrementalfalse, explicitly includes the two authored test files plus next-env.d.ts, excludes node_modules only. Typed scoped ESLint96873 terminal0 using root rules with projectServicefalse and that dedicated project. Default test lint initially refused because repository tsconfig excludes integration tests; this was resolved through explicit test inclusion, not disabled rules.
- Independent named review pending. Source apiResolver HTTP is verified; stale .next was not used. BuiltNext, rendered UI,100k load and production acceptance remain root programme work. No production verification.
