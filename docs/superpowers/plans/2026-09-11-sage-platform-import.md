# Sage Migration via Platform Import — Plan

**Goal:** the admin Sage migration commit posts historical invoices (and, later, Sage payments) through the persisted platform-import path, not the old `historicalImport:true` boolean, so every migrated document is backed by retained source evidence and an independent tenant approval.

**Branch:** `fix/sage-commit-platform-import-20260911`, delivered as its own PR, a follow-on to the forensic-controls programme. Until it lands, the programme's three `directPostBypassGuards` unit tests stay red; they are the Sage deploy blocker named in the programme PRs.

**Parent plan:** [`2026-09-10-platform-import-authority.md`](2026-09-10-platform-import-authority.md), which covers the platform-import maker context, retained source, preparation, the single-import approval and execution.

## Hein's decisions (2026-09-11)

1. One approval per prepared **batch**, binding every import and line by hash.
2. A tenant **owner or admin** may approve a historical import. It is still a second person, on a cookie session only, never impersonated, and never the preparing platform admin. This applies to historical imports only; no other operation's approver widens.
3. Sage **payments** are imported as historical settlements, so paid invoices are backed by journals.
4. A **missing due date** defaults to the invoice date and is recorded as defaulted.
5. **Probe Sage first** for an allocation source before building the payment kernel.
6. Deliver Sage as a **follow-on PR**. The programme's draft PRs open now, with Sage marked as a deploy blocker.

## Why the kernel as built was not enough (phase-1 finding)

- Every import needed its own approval, and approvals expire in 24 h. A 2,000-invoice migration meant 2,000 approvals.
- The approver role matched exactly `'admin'`, so a freshly onboarded owner-only tenant could not migrate at all.
- Paid-at-source invoices could not be represented. The kernel accepts `amountPaid` only when real payment journals back it.

## Settled design (phase 1b)

### Batch approval: one batch = one controlled operation = one effect

- **Storage (migration 685, built):** `control_historical_import_batches` holds one row per batch: a `platform_import` requester only, a protected manifest envelope, a sha256 manifest hash and `member_count`. `control_historical_import_batch_members` holds (batch, import, position, member fingerprint), with one position per import per batch.
  - A guard admits only the batch requester's own platform-prepared imports, in the batch tenant.
  - The member set is frozen at the creating commit by a position bound and a deferred completeness trigger.
  - Both tables have forced RLS and tenant SELECT only. platform_admin is limited to SELECT/INSERT, and loses UPDATE/DELETE on the imports and sources a batch binds.
- **Authority (685, built):** `control_approval_authorities` gains a batch arm, so a platform requester can resolve authorities for an approval of its own batch. Its caller check is now NULL-safe.
- **Operation (S4):** `historical_import_batch.post` on entity `historical_import_batch`. Its materializer re-materializes every member and binds each member's fingerprint, so any change to any member kills the approval through the kernel's existing "Approval material changed" check. The binding amount is the sum of the members.
- **Execution (S4):** one transaction, all-or-nothing, in manifest order.
  - Each member writes its own `control_operation_effects` row, carrying `batchId`, so existing receipt readers keep working.
  - The approval is consumed once, by the batch effect.
  - Batch size is capped by **measured** execution time, because Cloudflare cuts requests at 100 s. The working guess is about 200 members, unmeasured.
  - The single-import path stays unchanged, and `platformImportApproval.int.test.ts` stays green without edits.
- **Replay fix (S4):** a member effect would currently replay without the approver-authority recheck, a real weakening. Member effects must resolve through batch membership to the batch approval. RED test: revoke the approver, replay a member, expect refusal.
- **Rejected:** a multi-transaction batch with a lease. It needs an `executing` status, N-effect consumption, crash recovery and partial batches, which contradicts "the approval binds the whole batch".

### Owner-or-admin approver (migration 686, built)

- `control_mandatory_import_policies.owner_may_approve` is `boolean NOT NULL DEFAULT true`. `approver_role` and its CHECK are untouched, so pre-686 code reads the policy as before.
- The import policy binds as `owner_or_admin` when the flag is set. The allowance is part of the binding, so flipping it voids open requests and refuses execution of an approved one.
- `approverRoleAccepts` matches the role exactly. The one exception: a **mandatory** `owner_or_admin` policy admits an owner or an admin. Tenant `approval_rules` are never mandatory. Both the decision path and the execution recheck use this function.
- 686 also revokes platform_admin's UPDATE/DELETE/TRUNCATE on all five `control_mandatory_*_policies` tables.

### Approval-table privileges (migration 687, built)

- platform_admin, the platform-import maker, has BYPASSRLS. It keeps only what the path does: SELECT and INSERT on `control_operation_approvals`, UPDATE of `status`, `consumed_at` and `consumed_effect_id` (consume), and SELECT on `control_operation_decisions`. It can never write a decision.

### Sage payments (S3, waits on the probe)

- Sage receipt and supplier-payment lists carry amount, date, bank, party and the unallocated remainder. That is enough to back the payment **journal**. The lists carry **no allocation lines**, and receipts name the customer rather than identify it. The admin pull fetches no payment data today.
- Proposed kinds are `customer_receipt` and `supplier_payment`, always batch members. They post the payment journal as the bank leg and write the allocations. They never create or touch bank transaction rows.
- The allocation source is open until the probe answers. The fallback, derived oldest-first allocation that must reconcile exactly to Sage's figures, is **not** decided.

### Due date (S5)

- The document gains `dueDateBasis: 'source' | 'defaulted_invoice_date'` in the normalized, hashed source, visible to the approver.

## Slices

Every slice passes tsc, eslint and the touched integration files on the synthetic fixture (`--no-file-parallelism`), with mutation checks, and gets a blind review. S3 and S4 also get an adversarial ledger/controls review.

| Slice | Scope | Status |
| --- | --- | --- |
| S1 | Migration 685: batch and member tables, batch operation authority | Done; blind-reviewed (3ff381123, a458e0f5a, 6149d7063) |
| S2 | Owner-or-admin approver (migration 686) | Done; blind-reviewed (f922d1246, ecbef7f1f) |
| — | Review round: migration 687 plus test hardening | In progress (6560cd65a, awaiting re-review) |
| S3 | Payment kinds in the kernel, through the single-import path first | Waiting on Hein's probe |
| S4 | Batch kernel: assembly, materializer, member effects, replay fix, confinement, measured size cap | Waiting (after S3) |
| S5 | Sage builder: pull receipts and payments (and allocations if the probe finds them), bank mapping, reconciliation refusals, `dueDateBasis` | Waiting on the probe |
| S6 | Routes: sage-commit becomes prepare + assemble + request; sage-execute and a status GET; retire the three `directPostBypassGuards` tests | Waiting |
| S7 | UI: admin flow and the tenant "Import approvals" page with the batch manifest view; browser proof with a real second user | Waiting |
| S8 | Master reconciliation (see Forward notes) | Waiting |

**The probe** is read-only and shape-only, with at most 10 requests, against the one Sage company the session cookie is signed in to:

```bash
bun run scripts/sage/probe-allocations.ts --dry-run
read -rs SAGE_COOKIE && export SAGE_COOKIE && bun run scripts/sage/probe-allocations.ts; unset SAGE_COOKIE
```

## Forward notes

- **S4:** the `historical_import_batch.post` entry in `operationPermissions.ts` must use `rule:'historical_import'`. `loadApprovalRules` binds the mandatory import policy, and with it the owner-or-admin allowance, only for that rule type. Any other mapping leaves batch approvals admin-only, and nothing fails to say so. Pin it with an owner approving a batch.
- **S4:** a batch writer that needs platform_admin privileges beyond 687's must add them in its own migration, with a test that re-grants inside a rolled-back transaction and applies the file.
- **S8, migration renumbering:** this branch's migrations (685, 686, 687) and the whole forensic programme's 36 migrations collide or interleave with origin/master's. There are five exact collisions, at 626, 627, 644, 645 and 662; master is at 674. All of them are renumbered above master's latest at the master-reconciliation phase. Tests that read a migration by filename (for example the 685/686/687 re-apply and grants tests) must be updated with them.
- **Open:** Sage receipt `Status` codes and `Discount` semantics; whether TaxInvoice `FilterId 0` returns all invoices or only outstanding ones; real batch execution time; whether an expired approval can be re-requested on the same entity; approvals have no status-transition guard (a cancelled approval whose decisions are all approved can be set back to `approved` by any role holding UPDATE(status)), raised for triage.
