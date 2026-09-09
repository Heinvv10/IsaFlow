# MCP forensic controls progress ledger

## Authority and baseline
- Specification: committed c76b9706d84bd8c33fecad38d3aa9afe46fb424b, copied unchanged beside this ledger.
- Execution baseline: f57f71a75aa0c8ff2a0202c4b2c65d20f0de510e (fetched origin/master 2026-09-09).
- Integration branch: feat/mcp-forensic-controls-20260909.
- Integration worktree: /home/hein/Workspace/IsaFlow/.worktrees/mcp-forensic-integration-20260909.
- Original checkout and other sessions untouched. No production writes, messages, merges, or deployments authorized.
- Root owns shared contracts, registry/discovery, migration reservations, integration, and heavy-run scheduling.

## Phase/task status
| Task | Status | Owner | Evidence / next action |
| --- | --- | --- | --- |
| 0 baseline/remediation reconciliation | verified_current_schema | root | f57f71a7 baseline CI green Node22; historical replay220 limitation classified |
| 0 complete tool matrix | source_verified | inventory | forensic-evidence/tool-matrix.json: 131 tools,69 reads,62 writes,30 posting; runtime contract tests pending |
| 0 preventive bypass map/subplans | source_verified | preventive_map | forensic-evidence/phase1-preventive-plan.md and entrypoint-matrix.tsv; runtime reproductions planned |
| 0 evidence/detectors/subplans | source_verified | evidence_map | forensic-evidence/phase2-4-subplans.md |
| 0 disposable PostgreSQL and baseline CI | verified | root/evidence_map | reviewed fixture+3rootPGtests pass; current-schema upgrades616-618; historical replay220 separately limited |
| 0 shared contracts/requirement-test matrix | verified | root | 7e71e7d7 independent contract review clean;38requirements+22newtool contracts |
| 1 preventive shared controls | in_progress | root/permissions/approval | canonical+context reviewed; event writer626 undergoing proof; permission core+APapproval kernel underway |
| 2 change history/evidence | pending | unassigned | Minimal event writer required in Phase 1 |
| 3 detective checks | pending | unassigned | Reuse verified existing sources |
| 4 assurance/exceptions | pending | unassigned | Depends on consistent event/evidence contracts |
| 5 integrated proof/review/CI/draft PR | pending | root | All acceptance scenarios mandatory |

## Migration reservations
Root reservations after scanning all local/remote refs and existing worktree SQL filenames: 626 shared events/principal-lock helper; 627 operation approvals/policy versions; 628 beneficiary enforcement; 629 durable invocation/idempotency; 630 evidence/snapshot/exception jobs. Reservations627+ reordered centrally before any worker migration edits to match dependency order. Highest committed prefix was 625; no worktree file >=626 found. Recheck before commit/integration to avoid other-session races.

## Commands and findings
- `git fetch origin`: success; origin/master advanced c914f5b4 -> f57f71a7.
- `git worktree add ... -b feat/mcp-forensic-controls-20260909 f57f71a7`: success.
- Merged baseline includes remediation K001-K008/R003 plus supplier statement UUID/reconciliation fixes through PR356.
- Historical memory baseline CI omitted real DB integration; do not reuse as current verification.
- Existing committed fixture documentation reports historical migration replay stopping at 253; candidate baseline prerequisite until reproduced.

## Decisions
- Freeze f57f71a7 for initial baseline, inventory and CI; reconcile later upstream movement explicitly.
- User authorizes autonomous phase transitions and implementation decisions; routine skill confirmation gates are superseded.
- Preserve this durable ledger and evidence through completion and compaction.

## Review, blockers, verification levels
Baseline CI and reviewed foundations are recorded below. Full programme acceptance remains pending. Production unchanged and unverified.

## Resume
Read this ledger, worker report artifacts, and committed specification. Finish Phase 0 gate before dependent implementations. Never mark programme complete with pending capabilities/checks.

## Runtime and fixture
- Node v20.12.0 selected by nvm; Bun 1.3.9 installed (repo pin 1.3.2, minimum satisfied). Frozen install succeeded.
- Own container isaflow-forensic-pg-20260909, pgvector/pgvector:pg16, localhost:33149/isaflow_schema_fixture, disposable password forensic-local-only.
- Restored existing local schema-only artifact, preserving RLS/owners/grants; no source DB access. Restore log forensic-evidence/schema-restore.log. Historical migration replay and new upgrade migrations remain separate required evidence.
- Existing remediation branch list: forensic-evidence/remediation-branches.txt; baseline integrates only already-merged work.

## Baseline results and current tasks
- Node20.12 full CI exit1: unit/component Rolldown startup ERR_INVALID_ARG_VALUE format array; all remaining gates including build PASS. No app-code failure inferred. Log baseline-ci.log.
- Node22.23.1 full CI exit0 on a107aa8b (docs-only over f57f71a7): 787 unit files/9335 tests passed,36 files/234 tests skipped;57 component files/390 tests passed; build and all gates PASS. DATABASE_URL unset; no real DB acceptance in this run. Log baseline-ci-node22.log.
- Fresh historical migration replay first needs sslmode=disable, then fails at migration220 because companies does not exist. Confirmed pre-existing ordering prerequisite; new programme migrations will receive separate upgrade proof on current-schema fixture, historical replay remains tracked limitation.
- Shared contracts candidate and 38 requirement-to-test mappings recorded. Preventive worker reviewing cross-contract consistency; fixture worker owns safe bootstrap/tests, no heavy runs.

## Contract independent review
- preventive_map reviewed named4aa6907c: three confirmed contract gaps (multi-policy decision binding, nullable nonmonetary amount, employee beneficiary support). Fixed in following contract commit, plus explicit tx/lock/protected-evidence contracts. No code capability inferred from this review.

## Phase 0 gate and Phase 1 start
- Contract re-review of7e71e7d7: preventive_map confirms all three conflicts fixed; no remaining scoped contract blocker.
- Fixture3659c2ae independently reviewed clean, integrated aa16ec7a; root13unit pass. Worker realPG proof beaf6477 reports3pass (identity, RLS, rollback); review found P2 fault-injection cleanup setup gap, sent back for fix/re-review before integration of proof test.
- Phase0 source inventory, subplans,38requirement mappings, frozen contracts and reproducible current-schema baseline established. Historical empty replay gap remains confirmed baseline limitation, not waived proof. Synthetic fixture proof task cleanup fix still open; no Phase1 DB-dependent integration until reviewed.
- Root Phase1 common canonical contract task: tests written first; red missing module confirmed contracts-red.log; implemented real canonical material hashing/types;23unit pass, type-check and focused ESLint pass. Changes do not yet enforce financial operations. Independent review next.

## Integration through 30858728
- Fixture cleanup fixed3a796749; scoped review clean. Integrated1847ec5f/5c520265; root realPG rerun3pass on own33149 (fixture-postgres.log). Phase0 fixture proof complete; no production data.
- Canonical2003bddb review confirmed3P2 (locale ordering,nested validation,lossy arrays). Fixer24ae6eb3 reproduced16fail then53pass; scoped review clean; integrated30858728. No open canonical findings.
- Root transaction context task: missing-context and failed-evidence tests red before code. Cookie/bearer wrappers now bind authenticated principals and reject commit after required control evidence failure. Integrated focused79tests pass (context+canonical+3auth suites), type-check and focused lint pass. Independent review next; no shared financial writer integration claimed yet.
- Permissions worker branch feat/mcp-forensic-permissions-20260909 base2003bddb: live role/module/PAT/OAuth scope checks underway;21unit pass reported, DB proof and context integration pending. Worker waits root context commit.

## Current task ownership / next gates
- Contextba3d9ebd review found2P1 SQL/lifetime escape and1P2 buffered-response hang. Fixdf7e6e18 independently re-reviewed clean, integrated34751e31; helper signatures unchanged.
- Root event/protection task owns migration626,changeEventService.ts,changeProtection.ts,forensic-change-history.int.test.ts;5unit and initial3PG tests pass. Expanded4PG rerun awaits permissionDBlease; lint/typecheck pass; independent named review pending.
- Permissions08c72f17 source review no blocking code finding; P2 test defect(suspension masked foreigntenant assertion) sent to original worker. RealDB initial3pass1fail proved UPDATE-RLS membership-lock problem; root626 narrowdefiner helper fixes prerequisite, six-case rerun underway.
- Approval worker owns feat/mcp-forensic-approval-core-20260909 from34751e31, bounded AP approval kernel/materializers/tests; sends627schema contract to root. No domain executor integration claimed.

## Event foundation verification
- Root event/protection/version services: five unit tests and four real PostgreSQL tests pass, including encrypted exact/redacted generic history, database event time, stable operation identity, full rollback, concurrent version CAS, tenant isolation and caught encryption failure poisoning commit. Focused lint/typecheck pass; named-commit independent review pending. Logs change-history-green.log and change-protection-green.log. No domain writer enforcement yet.
- Current schema-only fixture retained privately at /home/hein/Workspace/IsaFlow/.worktrees/mcp-forensic-artifacts-20260909/current-schema.sql, mode600, SHA256 ad93bbd6286f113bfc68a564f9eb93abb232aa738d337a2754bb90d6c8677f5c. No production rows or production writes.

## Review corrections and approval schema
- Eventcb490931 independent preventive review found twoP1: default inherited UPDATE/DELETE grants defeated append-only ACL; context assertion outside failure handler let a caught invalid-context refusal commit earlier mutation. Both reproduced with real PostgreSQL failing tests, then fixed explicit privilege reset and failure-boundary context validation. Expanded sixPGtests pass; migration626 reapplied idempotently. Fix named-commit re-review pending.
- Reviewed permissioncore integrated7ba366d5, maskedtenant test root-reviewed32a3b8aa, proof8659b87f; worker sixPG and32focused tests pass. Current scope registry integration still pending.
- Root migration627 applied local-only: bound approval decisions, once-effect receipts, aggregate exposure, policy version/advisory serialization and current bound-authority helper. Kernel worker holds next DBlease; migration not yet independently reviewed.

## Integration and review queue at a0225c8f
- Event fixesade72372 independently re-reviewed clean. 626 next lock-order hardening is uncommitted and separately requires proof/review.
- Input validatorc95b1ed7 independently read/reviewed by root: no confirmed blocker in bounded schema/compatibility implementation; integrateda0225c8f. Worker302focused tests; root registry integration446passed3skipped (12filespass1skip), using actual131tool schema fixtures and mocked financial handlers. ActualHTTP/business-workflow proof remains pending.
- Root pending registry/currentpermission+newconsent integration: tenconsent tests redthenpass; currentauthority seven tests redthenpass; registryrefusal-before-replay test redthenpass; invalidargument gate three tests redthenpass. Existing registryunit tests explicitly mock independently tested authority/shape modules. Typecheck passed before latest registry edits, source lint passed; named review pending.
- APkernel84aae2e9 remains NOT integrated. Independent inventory review confirmed permit operation mismatch, missing persisted evidence parent, no-policy stableintent retry duplication, participant-lock snapshot race and policy-update deadlock. Worker has concrete PGred regressions and fixes underway; initial18unit/10PGgreen did not establish complete safety. Root627 aggregateidentity also corrected after two-beneficiary red.
- Root pending626/627 changes serialize tenant authority before person locks, policy statement before tuple locks, bind requester original grant, restrict immutable request columns, durable effect intent unique; current fixture upgraded. New628 beneficiary proposal/version/granthelper applied local-only, independent review pending. Worker explicit employee evidence-parent and configured-policy-facade gaps remain required follow-ups.
- Current owners: root contracts/registry/scopes/migrations/integration; evidence_map APkernelreviewfixes withDBlease; preventive_map beneficiarykernel+PGtests awaitinglease; inventory independent reviewer available. Heavy CI/build runs remain serialized and final CI not yet run.

## Preventive integration through 208e2fab
- Independent root review of cdf40a3a stableintent return-result correction clean; APkernel/fixes integrateda0d31706/4a5ca95e/93ea3768. Root real PostgreSQL run29passed3files across approvals17/history6/permissions6 (preventive-foundations-postgres.log). These prove the kernel, not existing financial writers.
- Beneficiary4d10c794/702257c9 independently reviewedclean (policyphantom redthenlockfix, rejection/cancellation audited); integratedef6bb42c/7515bdb8. Worker25unit8PGpass. Schema d4461713 independently reviewedclean; inherited626/627grant fixes andauthoritylock protocol retained.
- New root pureoperationpermissions contract208e2fab defines domain-specificread/write mapping and OperationRef.reversalDate for futureGL binding. Sixfocusedtests passed (including reviewedchildctxpermit03dd42a5); dispatcher integration stillpending actualGL materializer.
- APchildpermitaf3a19c0 root reviewedclean/integrated03dd42a5: different issuedControlTx handles in sameactiveprincipal accepted; nested independentexecution keyedprincipal refused, crossrequest/unissued contexts stillrefuse.
- Roottransactionobserver foundation29unitpass (observernotification afterwrapperCOMMIT/ROLLBACK, failures recoverableunknown); source lint/commit/review inprogress. It has not yet delivered durableinvocation admission orseparateidempotency store; migration629 pending.
- Fixture schema-only dump omitted migration410 raw_bytes fields. Applied exactf57f71a7:410_captured_document_raw_bytes.sql toownfixture; beneficiary evidence tests nowhash realbytes. Logfixture-migration410.log. Fullfreshcurrent-schema upgrade replay remains required; historicalemptymigration220 gap remainsunresolvedbaseline limitation.

## Current owned tasks and resume pointers
- Integrationworktree /home/hein/Workspace/IsaFlow/.worktrees/mcp-forensic-integration-20260909, branchfeat/mcp-forensic-controls-20260909; usegitstatus --untracked-files=all. No pushes/PRs/productionactions yet.
- evidence_map: .worktrees/mcp-forensic-ap-writers-20260909 from93ea3768; APinvoice/paymentsharedwriters, extractedhelpers, APmaterializer authoritativeaccountmapping+childsettlementevents. FourmissingctxactualwriterREDs; sameactiveprincipalpermitfix alreadyintegrated. Needsrootgenericdispatcher/GLgeneratedJournalPermit dependency. Existinginvoiceapprove/postaliases mustoneeffect, cancel/voidindependentoperation. NoNetcash/batchintegration yet.
- preventive_map: .worktrees/mcp-forensic-beneficiary-writers-20260909 from7515bdb8; suppliercreate/update/import/merge bankproposalbypassclosures. Allowedsmallkernelfix permits emptyproposal evidence (maintenancependingonly) whileverification requires exactnonemptyparent-boundevidence. Harmlesscontacteditscompatible; unauthorizedmixedbankeditatomicrefusal. Broaderemployeeevidenceassociation/configuredpolicyfacade stillrequired.
- inventory: .worktrees/mcp-forensic-gl-writers-20260909 from7515bdb8, cherry208e2fab/03dd42a5; GLmaterializer+brandedgeneratedJournalPermitcore thenGLpost/reversewriters. Elevenunitgreen/fourwriterRED reported. HoldsDBlease fordirectmaterializerPG; rootmustreviewcore namedcommitbeforedependencyintegration, thenwiregenericdispatcher. ExplicitreversalDate binds targetaccountingDate/targetperiod; amountbalancedexact, currencylockedcompanies.default_currencywithoutfallback.
- Root ownsmigrations/contracts/dispatch/scopes/registry andinvocationfoundation. All29rootPG completed; no rootDBrunactive. Current private synthetic envfile .worktrees/mcp-forensic-artifacts-20260909/fixture.env mode600 forworkercommands, neverlog/publishit.
- User-required laterphases2-5 remainpending beyondfoundations. Required missingcapabilities: completeAP/GL/payroll/locks/importdirectSQLenforcement, beneficiaryUI/rest/MCPevidence+paymentreleaseoutbox, all22tools, durableattempts/dedup, documentgraph/missing-evidencequery, complete detectors, repeatable snapshots/exports/jobs, exceptionrechecks, everytoolactualHTTPauth+contract, integratedUI/RESTworkflows/performance/adversarialproof, independentreview/finalbunrunci/draftPRs. Neverclaimprogrammecompletewhilethese remain.

## Integration checkpoint d2fb40a0
- Root generic dispatcher3a9c7198 initially had source TypeScript errors; corrected3f74ebda passes fullsource type-check and34focusedunit tests. Independent inventory review clean; actual10GLPG exercises dispatcher. AP reversal target extension35236915 has twoRED thenfiveGREEN tests; independentreview pending.
- Root observer71efeb26 review found P1: PostgreSQL can return command ROLLBACK to COMMIT after caught SQL failure. Real SQL and wrapper tests reproduce. Fix8d551407 checks actualcommand, settles rollback/unknown accurately and refuses buffered success. SevenrealPG and357authunit tests pass; inventory named re-review clean. Durable invocation admission and separate idempotency remain NOT implemented.
- GL bb745eb2 core integrated6bc5b08a; relationship06ad9d5e/eb56d6d1 integrated4b335a54/8dae6255; sharedwriters04b6183a/61992f53 integrated10c10ad0/d2fb40a0 after root committed-source review and22unit/10realPG pass. Initial5PG failures exposed mapper ownundefined receipt keys, fixed explicit safe DTO projection. Remaining coordinated generated AP child-date guard assigned inventory with RED first; not fullprogramme approval.
- Supplierwriters030955f9/f6ed2be2 notintegrated:43unit9PG pass, independent evidence_map review P2 missing active purchase_orders and standalone supplier credit_notes merge dependency guards. Workerfix992bef35 has twoRED/threeGREEN unit proof; twoadditionalPG pendinglease/review. Actualhandler tests mockauth/CSRF toinjectrealControlTx; no fullHTTP claim.
- ExclusiveDBlease now evidence_map for AP7sharedwriter+17kernel tests after GL+rootdependencies; rootnoDBactive. preventive waits next for11supplierPG. inventory unit/reviewonly. No heavyCI/build active.
- Next: review APdateextension andgeneratedchildfix, run AP actualsharedwriterPG andfixconfirmedfailures; review supplier992bef35 andrun11PG; integrate reviewedwriters; implement629durableattempt/separatededup then continue remaining fullprogramme capabilities listedabove.
