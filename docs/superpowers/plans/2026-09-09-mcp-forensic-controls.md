# MCP Forensic Controls Implementation Programme

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to execute phase-specific implementation plans. The root agent orchestrates independent workers and review gates.

**Goal:** Deliver tested, independently reviewed MCP forensic controls, backed by shared services that also protect REST, UI, and job execution paths.

**Architecture:** Reuse existing accounting services and expose bounded MCP adapters. Central shared authorization, approval, change-event and evidence contracts precede dependent endpoint work. Preserve existing wire contracts and tenant isolation.

**Tech Stack:** Next.js 14 Pages Router, strict TypeScript, pg-backed sql from @/lib/neon, GoTrue, Bun, Vitest, Playwright, disposable PostgreSQL integration fixtures.

**Spec:** This document's Scope, Control Contracts and Acceptance sections constitute the programme specification. Phase 0 produces exact file-level subplans against the verified execution baseline; this document is a phased handoff, not a claim that those implementation details are already validated.

## Global Constraints

- Follow root and nested CLAUDE.md/AGENTS.md. Node >=20.12.0; Bun >=1.3.0, repository pin bun@1.3.2. Use .nvmrc.
- Isolated branches/worktrees; never edit master or another session's work. Prefix shell calls with explicit cd. No stash, broad staging, hook bypass, or published-commit amendment.
- Review named commits using git show. Do not interpret a clean working tree as a durable review snapshot.
- Scope database access to the authenticated company. Evidence links must enforce parent ownership. Payroll and beneficiary information require narrowly scoped access and redaction.
- Max 300 lines per file. Real implementations; no placeholders or weakened tests to pass gates.
- Root allocates unused migration prefixes and owns registry, discovery, shared contracts, dependency and migration integration. Workers request shared-file changes through root.
- Implementation, synthetic local tests, commits, pushing feature branches and draft PR creation are authorized by the execution prompt. Production deployments, production migrations/data repair, external messages, and merging are excluded.
- No external bank/SARS submissions or real customer communications during tests. Use fakes for external systems, real PostgreSQL for transaction/RLS/concurrency proof.

## Evidence baseline and scope

The initial review inventoried 131 MCP tools (69 reads, 62 writes) at 5661d6f0f5f2212705151e95455a3f681ddf840e. Recount and revalidate at execution time. Many active remediation branches exist; do not duplicate or absorb them blindly. Old comments describing production are historical claims, not current measurements.

Existing foundations: src/lib/mcp/toolIndex.ts, registry.ts, audit.ts, contracts/*; pages/api/mcp/index.ts; src/lib/auth/bearerPipeline.ts. Existing tools include data_integrity_checks, audit_trail, chart_of_accounts_health, reconcile_subledger, bank_statement_coverage, period_close_checklist, and VAT/fixed-asset reconciliation.

Reuse candidates: services/gl/approvalService.ts, services/core/{anomalyDetectionService,duplicateDetectionService}.ts, services/capture/{supplierGraphService,auditTrailExportService}.ts beneath src/modules/accounting; existing approval, fraud, duplicate, audit-export, and supplier-invoice three-way-match REST routes. Existence is not proof that these services are safe or complete.

## Orchestration and completion protocol

Root plus at most three active workers. Give each worker a bounded task, owned paths, exact base SHA, input/output contracts, test command, and acceptance criteria. Separate worktrees for mutations. Root continues useful integration/contract work while workers execute. Use available slots for independent reviewers after implementations complete.

Serialize resource-heavy full CI/build/database runs on the shared host; workers may run bounded focused tests concurrently.

Each task: reproduce gap with failing test -> implement -> focused tests -> named commit -> independent specification and correctness/security review -> resolve findings -> integrate. Each phase: integration tests and full bun run ci on the integrated named state. Stop dependent work on a failed prerequisite; continue unrelated authorized work. Do not postpone testing until the programme end.

Keep a durable progress file next to this plan with baseline, branches, commit SHAs, owners, dependencies, migration reservations, test evidence, review findings, decisions and next actions. Findings use candidate, confirmed, fixed, verified, or blocked states. Distinguish code-tested, environment-tested, and deployed status. Compaction or a worker finishing does not complete the goal.

## Phase 0 — Revalidate and freeze contracts

Parallel read-only assignments: A inventories every current tool and scope; B traces approval, supplier, payroll and payment write entry points; C examines audit/evidence storage and existing detector coverage. Root selects and records the current integration baseline, reconciles existing remediation work, and runs baseline CI.

- [ ] Produce a complete tool matrix: name, scope, mutation/post flags, arguments, service, pagination, dry-run behavior, audit behavior and known coverage limits.
- [ ] Map all UI/REST/MCP/job paths capable of bypassing each proposed preventive control.
- [ ] Produce exact file-level subplans per subsystem with interfaces, concrete fixtures, failing tests, implementation steps and commands. Record scope decisions autonomously within this specification.
- [ ] Establish disposable migrated PostgreSQL with two tenants, two independent users in tenant A, one user in tenant B, and distinct tokens for the same user.
- [ ] Freeze contracts for approval-bound operation versions, effective permissions, audit events, check results and evidence snapshots. Decide compatibility and feature-flag migration behavior.
- [ ] Create a requirement-to-test matrix covering every capability in later phases.

Gate: reproducible baseline, full inventory, no unresolved shared contract conflict. Baseline failures must be classified with evidence; do not silently waive mandatory CI or expand into unrelated repair.

## Phase 1 — Prevent unauthorized high-risk changes

Workers: A approval service and enforcement; B supplier-bank proposal/verification workflow; C effective permissions and access review. Root owns shared contract wiring. Supplier implementation can develop against the frozen contract, but cannot integrate before approval enforcement passes.

Tools: approval_requirements, request_operation_approval, list_pending_approvals; propose_supplier_bank_change, supplier_bank_change_status; connection_permissions, access_control_review. Reuse the existing authenticated human decision UI/API where possible; add the minimum usable review flow where missing. Do not rely on an agent supplying approver identity or claiming verification occurred.

- [ ] Enforce actor separation using person identity, not token inequality. Enforce the configured approver role and current membership.
- [ ] Bind approvals to tenant, operation, server-derived amount, currency and beneficiary, document version, policy version, expiry, and a single execution. Define rejection/cancellation and concurrency semantics.
- [ ] Reject stale approvals after material edits. Evaluate controls in the executing shared service and transaction, not only in MCP previews.
- [ ] Land the minimal transaction-bound change-event writer and operation versioning before enabling either approval or beneficiary workflows; Phase 2 expands coverage and exposes history.
- [ ] Route bank-detail changes through proposal and independent evidence-backed verification. Preserve approved details until replacement activation; payment generation/release must respect holds and beneficiary version changes.
- [ ] Separate beneficiary-maintenance permission from ordinary contact edits. Preserve backwards compatibility of harmless contact changes while preventing bypass through older routes/imports.
- [ ] Calculate effective permissions from current role and granted scope; downgrades must remove authority without waiting for token expiry. Review conflicting/dormant grants without exposing secret tokens.

Acceptance: self-approval with another token fails; deactivated users and revoked approver roles fail at execution; wrong role/tenant fails; stale, expired and reused approval fails; amount splitting is checked where configured using aggregate limits; two concurrent executions cannot double-consume approval; direct REST/job execution cannot bypass it; verified independent approval succeeds once; rejected bank change preserves old beneficiary; old prepared payment cannot silently use new unverified bank details.

## Phase 2 — Complete change history and evidence links

Workers: A entity change capture; B MCP invocation history; C transaction evidence graph. Integrate event capture with all Phase 1 sensitive writes before declaring that phase's controls fully auditable.

Tools: entity_change_history, mcp_call_history, transaction_evidence_chain.

- [ ] Record tenant, principal, connection/grant identity, acting firm when known, request/operation IDs, actual event time, accounting date, entity/version, action, protected before/after values, outcome and provenance.
- [ ] Distinguish an invocation attempt from a committed financial effect. Record retries/replays without creating another financial effect. Failed attempts must survive financial rollback through a bounded, documented durable logging design.
- [ ] Separate idempotency retention from audit retention so pruning events never enables duplicate writes.
- [ ] Capture supplier banking, employee components, bank rules, GL classification, approvals, locks and ordinary non-ledger mutations; report historical gaps explicitly.
- [ ] Join supporting evidence across both existing document stores through authorized parent links. Explain missing, ambiguous and reversed links rather than manufacturing associations.

Acceptance: successful edit has exact before/after and authenticated actor; rollback produces no committed-change event; retry has separate attempt evidence and one effect; no plaintext token or unnecessary bank/payroll secrets; bank -> invoice -> approval -> journal -> payment evidence chain is navigable; cross-tenant IDs disclose nothing; invoice-filed evidence is not incorrectly counted as absent bank evidence.

## Phase 3 — Expose and strengthen detective checks

Workers: A duplicates/payment risk and three-way match; B journal risk and bank completeness; C payroll checks. Reuse verified detectors and avoid parallel sources of accounting truth.

Tools: duplicate_invoice_checks, payment_risk_checks, three_way_match_exceptions, journal_risk_checks, bank_statement_completeness, payroll_control_checks. Extend existing data_integrity_checks when the semantics fit instead of creating redundant tools.

- [ ] Detect duplicate invoices across changed references/imports, repeated payment intent, shared beneficiary accounts, and recent beneficiary changes. Distinguish candidate matches from confirmed duplicates.
- [ ] Check PO/receipt/invoice quantities and prices across complete populations, with recorded tolerances, overrides and partial receipts.
- [ ] Check actual-time versus accounting-date posting, reversal patterns, thresholds and closed-period changes. Statistical heuristics produce investigation leads, not fraud conclusions.
- [ ] Compare imported bank populations with independent source statement counts, periods and balances. A transaction-free day is not proof of missing data; no gaps is not proof of completeness.
- [ ] Reconcile payroll totals/liabilities/settlements and detect bank-account reuse, changed salary components, terminated employees paid and zero-cost employees.

Acceptance: seeded true cases detected; recurring legitimate invoices/payments and other negative controls remain distinguishable; totals cover all findings beyond pagination; missing source statements yield unknown; unavailable external confirmation never yields verified; one failed check does not make the overall run pass; payroll-sensitive data remains restricted.

## Phase 4 — Reproducible assurance and exception resolution

Workers: A audit snapshots/comparison/export; B exception workflow; C independent control-contract and adversarial review.

Tools: audit_snapshot, compare_audit_snapshots, export_audit_evidence; control_exceptions, assign_exception, resolve_exception.

- [ ] Snapshot a consistent population with reporting cutoff, actual capture time, source versions, counts, exclusions, check versions and evidence hashes. Document whether snapshot materializes records or otherwise preserves reproducibility.
- [ ] Detect later backdated postings, edits, reversals and changed classifications or check-rule versions without altering the original snapshot.
- [ ] Extend existing exports with complete manifests and retained evidence. Hash stable canonical snapshot data separately from rendered PDF bytes; do not assume repeated PDF rendering is byte-identical. A hash stored beside mutable source data is not independent tamper protection; define and test the actual trust boundary.
- [ ] Persist finding identity, recurrence, owner, due date, evidence, independent review and recheck result. Require an independent verifier for high-risk findings. Separate accepted risk from remediated findings. Reopen recurring conditions.
- [ ] Use bounded asynchronous jobs/status/pagination for large scans and exports; reads must not secretly trigger unbounded processing.

Acceptance: concurrent writes cannot create a mixed-state snapshot; original remains reproducible after backdated posting; comparison identifies the change; artifact alteration is detected; evidence access is tenant-scoped; failed recheck cannot close as fixed; accepted-risk status remains visible; recurring exception reopens; export population matches snapshot counts/totals.

## Phase 5 — Integrated proof and delivery

- [ ] Test every registered tool for manifest/discovery consistency, input validation, scope behavior and expected error shape. Preserve compatibility for existing consumers.
- [ ] Run focused unit tests, migrated real-DB integration tests, RLS/cross-tenant tests, rollback/idempotency/concurrency tests, and relevant Playwright flows.
- [ ] Perform local HTTP MCP initialize/tools-list/tools-call acceptance using synthetic bearer identities. Exercise underlying UI/REST paths, not only direct service calls.
- [ ] Run one complete supplier case: proposal -> unauthorized approval rejected -> independent approval -> bill -> three-way exception -> approved correction -> settlement -> bank evidence -> audit snapshot -> backdated correction -> snapshot diff -> reviewed exception resolution.
- [ ] Run payroll and close-period cases with deliberately incomplete evidence and confirm unknown/block behavior.
- [ ] Exercise representative large datasets with explicit latency, pagination, job recovery and resource bounds established in Phase 0.
- [ ] Independent reviewers inspect the exact integrated commit, including bypass routes, migrations, sensitive-data exposure and evidence claims. Fix confirmed in-scope issues and rerun affected checks.
- [ ] Generate agent-doc mirrors where canonical docs changed. Run bun run ci on the final integration commit before any PR; record SHA and command results.
- [ ] Create reviewable draft PR(s) with final behavior, migration/rollout notes, test evidence and limitations. Do not merge or deploy.
- [ ] Final report: completed capabilities, exact commits/PRs, tests and representative workflow evidence, unresolved blockers, historical coverage gaps, and explicit statement that production is unchanged/unverified.

Definition of done: all approved programme capabilities implemented, integrated, independently reviewed and verified by the stated acceptance scenarios, required CI green, durable evidence and draft PR handoff prepared. An endpoint stub, mocked-only transaction proof, unreviewed branch, or planning document is not completion. A blocked external dependency must be reported truthfully; continue independent work and do not mark the entire goal complete with required work outstanding.
