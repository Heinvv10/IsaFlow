# IsaFlow Audit Remediation Goal and Execution Plan

> For agentic workers: use superpowers:executing-plans to execute sequentially. Prepare a concrete implementation/test plan for each validated root cause before changing its code. Do not implement hundreds of unverified audit claims as if they were a specification.

**Goal:** Resolve every candidate in the combined audit through evidence-backed validation, remediation where needed, regression tests and workflow verification, completing each root cause before starting the next.

**Architecture:** Maintain a durable finding register and small isolated changes. Preserve original report IDs and evidence; reconcile claims against both the audited commit and the current execution baseline. Separate code verification, deployed verification and historical data repair.

**Tech Stack:** Next.js 14 Pages Router, strict TypeScript, React 18, PostgreSQL/Supabase GoTrue, Bun, Vitest and Playwright.

**Spec:** The user-approved candidate backlog, original audits and comparison listed in the prompt below.

## Goal prompt

```text
/goal Remediate the complete IsaFlow candidate audit backlog, one validated root cause at a time. Persist until every candidate has an evidence-backed disposition and every confirmed bug has been fixed and proven working through the required verification gates. Do not stop after planning, a first batch, passing unit tests, or creating a PR. Do not claim completion while required verification or external dependencies remain unresolved.

1. Establish scope and preserve evidence.
Read /home/hein/Workspace/IsaFlow/AGENTS.md and applicable module instructions.
Use these inputs:
- docs/audits/2026-09-08-combined-findings.html in the main IsaFlow checkout.
- docs/audits/2026-09-08-claude-full-code-audit.html and available 2026-09-08-detail reports in that checkout.
- /home/hein/Workspace/IsaFlow/.worktrees/codebase-audit-20260908/docs/audits/2026-09-08-codebase-audit.html.
- The adjacent 2026-09-08-audit-comparison.html, comparison-*.md and reproduction artifacts.
These are candidate findings, not proof of 281 distinct bugs. Preserve the original documents. Record the input file hashes, audited SHA 5661d6f0f5f2212705151e95455a3f681ddf840e and current baseline SHA. Read committed source using git show <sha>:<path>. Account for fixes already merged since the audit.

2. Create a durable remediation register and dashboard.
Create docs/audits/remediation/backlog.json and index.html on an isolated remediation branch/worktree. Include every K ID and all A/B source IDs; retain aliases when combining root causes. For each item record: claim, corrected trigger, severity rationale, affected paths, audited/current SHA, status, dependencies, test names, evidence paths, fix commit/PR, deployed SHA and historical-data impact.
Use explicit states: candidate, confirmed, in-progress, code-verified, awaiting-environment, deployed-verified, false-positive, duplicate and already-fixed-verified. A duplicate must identify its canonical item. A false positive must cite disconfirming evidence. Already-fixed requires current regression verification. Never silently drop an item. Validate that all source IDs are represented exactly once or as explicit aliases.

3. Apply the agreed corrections before prioritizing.
- C5/K-007: committed GRN creation fails on nonexistent po_items.company_id and rolls back; missing ownership checks also need repair. Do not claim durable cross-tenant corruption from that failing transaction.
- C18: missing Twilio credentials return 503; preserve only the supported destination-routing issue.
- H10/K-094: reject the claimed ExcelJS string-cell formula injection using the recorded XLSX reproduction.
- H36 and C4: migration 501 resolves a covering fiscal period on INSERT; distinguish missing-period cases and the independent foreign-account ownership defect.
- C6: withAuth supplies an outer transaction; retain the WIP locking/count race.
- C12: table allowlist bypass remains subject to AST tenant scope and RLS. Do not claim a demonstrated cross-tenant read.
- C7: sequential payroll recalculation removes the repayment deduction while retaining the reduced loan balance.
- H50/F13: migration 429 defines ux_sub_mandates_company_active. Multiple pending activations fail the unique index; they do not leave multiple active mandates.
- C21/K-037: keep environment/schema-dependent and unverified until the relevant schema and transaction behavior are established.
- H2/K-080: validate effective-dated SARS rules, eligibility and hours normalization. The cited 50% rate is outdated. SARS lists 75% below R2,000 for March 2022–March 2025 and 60% below R2,500 from April 2025. A qualifying first-year, 160-hour employee earning R5,000 in May 2025 exposes a clearer error: the audited formula gives R1,250 rather than R1,500. Verify official guidance before implementation, including historical periods.
- Agreement between auditors is supporting evidence, not the priority rule.

4. Establish the execution baseline.
Use an isolated worktree outside master; preserve unrelated changes and never stash. Follow the runtime pins and run bun run ci once to establish baseline failures and skipped coverage. Prepare disposable PostgreSQL using committed migrations, two companies with distinct fixtures, and representative roles. Use provider test modes and local capture sinks for external effects. Do not alter production data to reproduce bugs.

5. Order work by validated impact and dependencies.
Default sequence:
a. Authentication, authorization, tenant isolation and sensitive-data access.
b. Financial posting integrity, concurrent updates, idempotency, reversals and transaction rollback.
c. Payment/webhook retry handling, subscription lifecycle and capture/import durability.
d. Payroll, statutory calculations/exports, loan schedules and recurrence.
e. VAT, financial statements, assets, reconciliations and migrations.
f. Broken routes, exports, UI workflows and remaining medium/low candidates.
Move prerequisites ahead when necessary and record why. Fix one root cause at a time; group multiple callers only when they share that root cause. An externally blocked item stays open with its precise dependency; continue independent work without representing the blocked item as resolved.

6. For EACH candidate, complete this cycle before moving on.
a. Trace the real caller through API/service, authentication, transaction boundaries, schema constraints, triggers, RLS and output. Establish reachability on the current baseline.
b. Confirm the failure with a deterministic regression test before modifying behavior. The test must fail for the claimed reason. If disproved, record evidence and close as false-positive or duplicate; do not implement a speculative fix.
c. Write a small implementation plan identifying exact files, test cases, contracts, schema effects and rollback strategy.
d. Implement the smallest complete correction, preserving tenant scoping and existing contracts. Add no stubs or disabled gates. For migrations use the next unused prefix, required idempotent DDL and a disposable upgrade test.
e. Show that the previously failing test now passes. Cover the adjacent failure cases specific to the defect: wrong tenant/role, retries, concurrent requests, partial failure, date boundaries, or malformed inputs.
f. Prove the full affected workflow. Use real PostgreSQL for SQL/schema/RLS/transaction claims and deterministic simultaneous requests for races. For financial changes assert balanced journals AND agreement with invoice/payment/subledger balances. For UI changes exercise the actual page/API/data path with Playwright. Provider mocks prove contracts only; verify provider behavior in its sandbox where available.
g. Review the named fix commit against the claim and module rules. Resolve review findings and rerun affected tests. Run bun run ci before every PR as required by this repository. Do not weaken checks to make the change pass.
h. Commit only explicit task paths. Create a focused draft PR with trigger, before/after behavior, evidence, remaining limits and migration/rollback details. Update the register and HTML dashboard before advancing.

7. Keep proof and integration status truthful.
Code-verified is not deployed-verified. No production deploy, merge, historical financial-data mutation, destructive repair or external message is authorized by this prompt. Prepare concrete reviewable changes and migration/repair dry runs first; request the necessary explicit authorization only when that action is ready. Do not repeatedly ask for authorization already granted. Continue independent remediation while an external action is pending. After an authorized deployment, verify the deployed SHA and affected workflow before marking deployed-verified.
For each financial defect, assess whether existing records could be affected. Produce a scoped read-only impact query and, if needed, an idempotent repair plan with reconciliation and rollback checks. Never assume correcting future writes repairs past data.

8. Run final acceptance after all items are dispositioned.
Rebase/update through the authorized integration process, resolve conflicts and run the complete CI gate on the final candidate SHA. Run a cross-module acceptance matrix covering tenant isolation; invoice/payment/credit/reversal lifecycle; bank import/allocation/reconciliation; payroll calculate/recalculate/approve/export; loans/assets; billing/webhook retries; capture; reports/exports; and every repaired UI route. Include historical-period and negative-path cases where relevant. Check that no fixed defect was reintroduced by later changes.
Report all skipped tests and unavailable integrations explicitly. A skipped required test does not satisfy acceptance. Verify final register completeness and every evidence link.

9. Deliver and stop only at an honest completion boundary.
Publish the local HTML dashboard and final report with counts by disposition, remaining open dependencies, fix commits/PRs, test results, deployed verification and historical repair status. Claim all issues remedied only when every confirmed issue meets its required gates; otherwise state exactly what remains. False positives and duplicates count as reviewed dispositions, not fixes. No generic claim that the codebase is bug-free.
Give concise progress updates during execution and a self-contained result after each completed root cause. Preserve the register across context resets so execution resumes from the next open item.
```

## Execution checkpoints

- [ ] All source findings imported and reconciled; corrections recorded.
- [ ] Baseline SHA, CI results and disposable integration environment recorded.
- [ ] Each confirmed root cause completes the fail → fix → pass → workflow → review cycle.
- [ ] Every PR passes the required CI gate; skipped required checks remain visible.
- [ ] Historical-data impact assessed for each relevant defect.
- [ ] Authorized integration/deployment verified separately from code correctness.
- [ ] Final cross-module acceptance and register completeness checks pass.
- [ ] Final HTML report accurately distinguishes fixed, disproved, duplicate and blocked work.
