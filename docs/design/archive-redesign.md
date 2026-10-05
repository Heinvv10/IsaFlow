# Archive redesign — spec and decision list

**Status:** proposal. Nothing here is built. Archiving stays switched off (`POST /api/accounting/data-archiving` → 403, since 2026-09-24, #506) until Hein decides §2 and the re-enable gate in §10 passes.
**Closes, once built:** R-053, R-191, R-192, R-194. **Supersedes:** R-186's skip-and-refuse (live since #632). **Depends on:** R-195 (cross-company request FK, in the 2026-10-05 gateway goal).
**Measured on:** origin/master `470df5599`, own disposable fixture `isaflow-fixture-archive-spec` (schema cloned from the fleet template, migrations up to `852_gateway_fee_journal_unique.sql`, 424 rows in `schema_migrations`). Production was not queried. The archive integration suites (`k071-archive-delete-order` and the five `r186-archive-*` files) pass 26/26 there, so the registered behaviour still holds on master.

---

## 1. What is wrong today, in one paragraph

`executeArchive` copies five relations into `archive_*` mirror tables and deletes the originals. Four things make that unsafe, and each one is a whole class of defect, not a single bug:

1. **Every report reads only the live tables, and the balance-sheet family is cumulative from inception.** `fetchBalanceSheetData` (`reports/balanceSheetService.ts:131`), `bankGlBalanceAsAt` (`bank/bankReconciliationBalance.ts:52`) and the trial balance's asset, liability and equity accounts (`gl/trialBalanceService.ts:141-151`) sum every posted line with `entry_date <= asAt` and no lower bound. Retained earnings is derived from all revenue and expense lines up to `asAt` (`calculateRetainedEarnings`). So deleting pre-cutoff journals changes **today's** balance sheet, bank balance and retained earnings, not only reports dated before the cutoff. The 403 message understates this. No report reads any `archive_*` table; the only reader is the archived-journals list (`archiveReadService.getArchivedEntries`).
2. **The delete hits 40 NO ACTION foreign keys** (§A1). R-053 counted 37 on 2026-09-25; three have been added since: `gl_journal_entries.late_claim_of_id`, `gl_journal_document_links.journal_entry_id` and `supplier_payments.settles_provisional_je_id` (diffed against the list in `R-053/red.log`). So any company with a paid invoice, a receipt, a VAT return or a payroll run before the cutoff fails the run whole (23503). There are also soft references with no FK at all: 14 by column name, plus polymorphic and array links (§A3). They dangle silently: that is R-191.
3. **The mirror tables have drifted from the live tables.** 105 live columns are not in any archive table (§A4). Among them: `gl_journal_lines.vat_type`, `company_id` and the cost-centre columns; `customer_invoices.external_ref`, `currency_code`, `exchange_rate`, `rendered_pdf_sha256`; `supplier_invoices.is_drc`. The archive keeps an incomplete record, and the drift is what made every run fail on 42703 until K-071 (R-053 history).
4. **Copy and delete are separate statements** (R-192), and the CASCADE children of an invoice go with no copy (R-194).

---

## 2. Decision list for Hein

Each line is one decision. The recommendation is the default if Hein answers only "agree". §3–§9 hold the reasoning and the options.

| # | Decision | Recommended | Closes |
|---|---|---|---|
| **D0** | Should records physically leave the live ledger at all? | **No. Retire physical archiving.** Remove `executeArchive`, the Archive Now path and the five mirror tables (after the census in §9 shows them empty). If users want old years out of the way, add a *logical* archive later: archived fiscal years are locked and hidden from default list filters, and no row moves. | R-053, R-191, R-192, R-194 by removal; R-186's skip becomes moot |
| D1 | *(only if D0 = keep)* Which record kinds may leave? | Settled document closures only: customer and supplier invoices, receipts, supplier payments, allocations, credit notes, write-offs, reconciled bank lines, and the journals that belong to them. Journals that belong to no movable document (manual, payroll, depreciation, VAT return, year-end, loans, intercompany) never leave. | R-053, R-191 |
| D1b | *(only if D0 = keep)* What do reports spanning the cutoff read? | **Roll-forward journals plus frozen report packs.** One balanced `archive_rollforward` journal per archived fiscal year, dated that year's last day, carries the moved lines' net per (account, project, cost centre, cc1, cc2, business unit). P&L nets stay on their own P&L accounts. The cutoff must be both a fiscal-year start and a VAT-period start. Reports for dates before the cutoff are refused live, and are served from a report pack frozen at run time. Not archive-aware reports. | #506's reason for the switch-off |
| D1c | *(only if D0 = keep)* Duplicate guards and numbering | A live `archive_keys` table holds the unique keys of moved rows (supplier+bill number, card reference, fee reference, capture source document, bank feed identity, journal number), and the five unique guards consult it. Journal numbering uses a per-company high-water mark, not `MAX` over live rows. D1 depends on this. | — |
| D1d | *(only if D0 = keep)* Comparatives and approvals | The cutoff is at least two fiscal years back, so the first live year's comparatives are still live. Only an owner may run or restore an archive; a second owner approves. | — |
| D2 | *(only if D0 = keep)* Copy-then-delete atomicity | Lock the closure `FOR UPDATE` (bounded by the row-lock budget), then move each table with one `DELETE … RETURNING` feeding the archive `INSERT`. Count checks: moved = selected, archived = moved. No `ON CONFLICT DO NOTHING`. | R-192 |
| D3 | *(only if D0 = keep)* Must a journal move only with its document's whole closure? | **Yes.** The closure is the connected component over the edge list in §5.2. A closure moves whole or not at all. | R-191, R-053 |
| D4 | *(only if D0 = keep)* Child rows (items, views, disputes, dunning) | Archive each document as one JSONB snapshot of its whole tree in a single `archive_records` table. Do not add four more mirror tables, and do not refuse invoices that have children (every invoice has items). | R-194, and the drift in §1.3 |
| D5 | *(only if D0 = keep)* Archive table integrity | `archive_records`: `company_id NOT NULL` FK to companies, `run_id NOT NULL` FK to archive_runs, forced RLS, `SELECT` only for app_user, an immutability trigger, and no FKs to live tables. | R-053 |
| D6 | *(only if D0 = keep)* Reversibility | Restore the latest unrestored run only, through a service that refuses on any conflict. Every run and restore goes to `audit_log`. | — |
| D7 | Rollout | Run the §9 census on prod first. POST stays 403 until every gate in §10 passes. Fix N1 (below) regardless of D0. | — |
| D8 | *(only if D0 = keep)* Out-of-ledger artefacts and erasure | Stored PDFs and attachments in object storage stay where they are; the snapshot keeps their paths. A POPIA erasure on an archived record redacts the payload through a logged, owner-approved path, not by bypassing the trigger ad hoc. | — |
| D9 | R-195 if D0 = retire | Still fix it (composite FK, as the gateway goal plans): the cross-company reference is wrong whatever the archive does. | R-195 |

**The strongest argument against D0 = retire:** this was presented as a feature (WS-7.4), and the page, the stats and the preview exist. Retiring it removes a nav item someone may expect, and gives up the stated goal of "DB performance". But no measurement shows a performance problem: there is no row-count census, and the hot journal and bank queries are indexed on company and date (`idx_gl_je_company_date`, `idx_gl_journal_entries_company_date_posted`, `idx_bt_company_date`). The retention law asks us to *keep* records (§8), not to move them. Those indexes do not bound the from-inception scans (balance sheet, TB, bank balance), so cost does grow with history. If the §9 timing census shows a slow balance sheet for the largest tenant, the fix is **closed-year opening snapshots**: a cached per-account, per-dimension balance at each locked fiscal year-end that the cumulative reports start from. Every record stays live. Date partitioning would not help, because a range with no lower bound prunes nothing. The adversarial review of this spec found six ways option C breaks reports dated *after* the cutoff (findings in §4.2 and §6); each is fixable, but each adds scope to C.

### New findings (not yet registered; proposed entries)

- **N1 — `archive_gl_journal_lines` is readable across tenants.** It has no `company_id` column, RLS is off, and `app_user` holds SELECT, INSERT, UPDATE and DELETE (§A2). Every other `archive_*` table has forced `tenant_isolation`. Any authenticated request path that reads it would see every company's archived lines. Today the only code that touches it is the archive run, and the table is expected to be empty (no run has ever completed, R-053), so exposure is the census in §9 query 3. *Fix regardless of D0:* drop the table if empty (D0 = retire), or revoke from app_user.
- **N2 — The retention period is mislabelled.** `archiveQueryService.validateArchive` and the wizard say "5 years … SA Companies Act". The Companies Act 71 of 2008 s24 requires accounting records for **7** years (the current year plus the previous seven completed financial years, read with s28). The Tax Administration Act s29 requires 5 years from the return, longer while an audit or objection is open. The 5-year floor is the tax rule, not the Companies Act rule. If archived records stay readable, moving them does not breach either. If D0 = keep, the floor should be 7 years and the copy should be corrected.
- **N3 — Mirror-table drift (§A4).** This is folded into D4, and needs no separate register entry if D4 is accepted.
- **N4 — Writers outside the archive touch archived rows.** `customerMergeService` rewrites `archive_customer_invoices.customer_id`, and both Sage importers look up `archive_*_invoices` by number or Sage id to avoid double-booking. Any D4 design must keep those two lookups. That means indexed JSONB keys for `invoice_number` and `sage_invoice_id`, and a merge redirect instead of a rewrite of immutable rows.

---

## 3. D0 — Should anything leave the live ledger?

| Option | What it is | Cost | Risk |
|---|---|---|---|
| **A. Retire (recommended)** | Delete the execute path and the mirror tables. Keep stats, and make the page an explanation, or remove it. | Small: one migration (drop, after census), service and page removal, test removal. | None to the ledger. |
| B. Logical archive | `fiscal_years.archived_at`. Archived years are locked (already required), excluded from default list filters (invoices, journals, bank lines) and shown behind an "include archived years" toggle. Nothing moves. | Medium, mostly list filters. | Low. A filter missed in one list only shows extra rows. |
| C. Physical archive, redesigned | D1–D6 below. | Large: closure engine, roll-forward, report packs, restore, ~6 PRs, adversarial review on each (it writes the GL). | High: GL writes, 40 FKs, every future FK into a movable table must be classified (§5.3). |

**Recommendation: A now, B only if a user asks.** C is specified below so the choice is informed, not so it gets built.

---

## 4. D1 — Which record kinds may leave, and what do reports read?

### 4.1 Record kinds

| Kind | May leave? (if C) | Why |
|---|---|---|
| Customer invoices, credit notes, write-offs | Yes, as part of a settled closure | Statements and aging net to zero for a settled closure (§4.3). |
| Receipts (`customer_payments`) and their allocations | Yes, with the closure | A receipt allocated to a live invoice joins that invoice's closure, so the closure stays live. |
| Supplier invoices, supplier payments, both AP allocation tables | Yes, with the closure | Same reasoning, AP side. |
| Reconciled bank lines | Yes, with the journal line they match | `matched_journal_line_id` is an edge (NO ACTION). An unmatched reconciled line moves alone. |
| Journals of those documents | Yes, only with their closure | R-191. |
| Manual, payroll, depreciation, VAT-return, year-end, loan, intercompany, stock and asset journals | **No** | Each one is referenced by a live record kind that has no archive design (`vat_returns`, `payroll_run_headers`, `asset_disposals`, …, §A1). Moving them means widening to ~30 relations, which R-053 already rejected. |
| Quotes, sales orders, delivery notes that reference an invoice | Block the closure (NO ACTION) | These are operational documents with no archive design. An invoice they point at stays live. |

### 4.2 What reports read across the cutoff

| Option | How | Verdict |
|---|---|---|
| a. Archive-aware reports | Every report `UNION`s live and archive rows. | **Rejected.** Every report service that reads the ledger or the subledgers would change (the balance sheet, TB, GL detail, VAT, aging and statement services alone are more than a dozen), and every future report must remember to do it. One that forgets is silently wrong. |
| **b. Roll-forward + frozen packs (recommended if C)** | The cutoff must be a fiscal-year start **and** a VAT-period start. The run posts one `archive_rollforward` journal **per archived fiscal year**, dated that year's last day. It carries `SUM(debit − credit)` of the moved lines grouped by (account, project, cost_center, cc1, cc2, bu). P&L nets stay on their own P&L accounts; they are **not** moved into retained earnings. The trial balance derives the `RE-BF` row from prior-year P&L lines (`trialBalanceBasis.getRetainedEarningsBroughtForward`), and live year-end close journals still debit revenue, so posting P&L into RE would change the rows and double-count a closed year. Each moved journal balances, so each roll-forward balances. The journal has its own `source`, which every VAT report excludes as it excludes `VAT_SUBMISSION_CLEARING_SOURCE` (otherwise `vatReturnService`'s unclassified fallback sweeps roll-forward lines on VAT accounts, which carry no `vat_type`, into box 1 or 15). Live reports for any date on or after the cutoff then read the same totals. Reports for dates before the cutoff are refused live, and are served from a pack generated **before** the move (TB, balance sheet, income statement, GL detail, VAT201s, aged debtors/creditors at each archived year-end) and stored in `archive_records` as kind `report_pack`. | Report continuity is a tie-out test, not an argument (§10, G2). |
| c. Roll-forward only, no packs | As b, but pre-cutoff reports simply show the collapsed roll-forward. | Rejected. A pre-cutoff TB would be silently wrong, not refused. |

The roll-forward posts into a locked period, so it needs a dedicated, privileged posting path (`posting_agent = 'system:archive:v1'`). It must not unlock the period.

### 4.3 Why settled closures keep the subledger reports whole

- Customer statement brought-forward (`ar/customerStatementRules.ts:39-67`) is invoices minus receipts minus credit notes before the from-date. It does **not** subtract write-offs. A closure settled by receipts and credit notes contributes zero, so moving it leaves the b/f unchanged. A closure settled by a write-off contributes the written-off amount today, so moving it would change the b/f. Either closures with a write-off stay live, or the statement rule is fixed first (it is arguably wrong already). G2 includes the case.
- Aged debtors and creditors read open items only (`arSubledgerService`, `apSubledgerService`). A settled closure has no open item.
- The AR and AP control accounts carry forward through the roll-forward, so subledger-to-GL reconciliation still foots. That needs proof against every tenant (G2).

---

## 5. D3 — Closure (R-191, R-053)

### 5.1 Rule

A **closure** is the connected component of documents and journals reached from a seed (an eligible invoice, bill or reconciled bank line) over the edges in §5.2, in both directions, within one company. A closure is **movable** only if every member is movable:

- documents: settled per kind, using each table's own CHECK domain: invoices and bills `paid`/`cancelled`; receipts `confirmed`/`reconciled`; supplier payments `processed`/`reconciled`; credit notes `applied`; write-offs `approved`; bank lines `reconciled`. Each must be dated before the cutoff, with no open balance;
- journals: posted, dated before the cutoff, in a locked period, and every record that references it is in the same closure.

A member reached through a blocking edge (§5.2, "blocks") makes the whole closure stay. So does any edge to another company's row: the run never touches, and never ignores, a cross-company neighbour. There is no partial move. The preview reports closures moved and closures kept, each kept one with the first blocking edge, so the user can see why.

### 5.2 Edges (from §A1 and §A3)

| From | To | Link | FK | In closure |
|---|---|---|---|---|
| customer invoice | its journal | `customer_invoices.gl_journal_entry_id` | **none** (soft) | yes |
| supplier invoice | its journal | `supplier_invoices.gl_journal_entry_id` | NO ACTION | yes |
| invoice | allocation | `customer_payment_allocations.invoice_id` | NO ACTION | yes |
| invoice | credit-note allocation | `credit_note_allocations.invoice_id` | **none** (soft) | yes |
| allocation | receipt | `customer_payment_allocations.payment_id` | CASCADE | yes |
| receipt | its journal | `customer_payments.gl_journal_entry_id` | NO ACTION | yes |
| receipt journal | gateway fee journal | `reference` (unique since 852) | **none** (soft) | yes |
| invoice | credit note | `credit_notes.customer_invoice_id` / `supplier_invoice_id` | NO ACTION | yes |
| credit note | its journal | `credit_notes.gl_journal_entry_id` | NO ACTION | yes |
| invoice | write-off (+ journal) | `customer_write_offs.invoice_id`, `.gl_journal_entry_id` | NO ACTION | yes |
| supplier invoice | AP allocation, payment, journal | `supplier_payment_allocations`, `payment_allocations`, `supplier_payments.gl_journal_entry_id` / `settles_provisional_je_id` | NO ACTION | yes |
| supplier payment | batch (+ journal) | `supplier_payment_batches.gl_journal_entry_id` | NO ACTION | **blocks** (a batch spans many payments) |
| journal line | bank line | `bank_transactions.matched_journal_line_id` | NO ACTION | yes |
| journal | bank line | `bank_transactions.provisional_je_id` / `transfer_journal_entry_id` | SET NULL / **none** | yes |
| bank line | allocation batch line, attachment | `bank_allocation_batch_lines`, `bank_transaction_attachments` | **none** | yes (snapshot) |
| journal | reversal / late-claim chain | `reversal_of_id`, `late_claim_of_id` | NO ACTION | yes |
| journal | document links, date corrections | `gl_journal_document_links`, `gl_entry_date_corrections` | NO ACTION | yes (snapshot) |
| invoice | payment request | `paystack_/stitch_payment_requests.customer_invoice_id` | SET NULL + CHECK | yes if completed; **blocks** if open (replaces R-186's skip) |
| invoice | items, views, disputes, dunning | CASCADE children | CASCADE | yes (snapshot, D4) |
| invoice | time entries, portal links, payment transactions, captured documents | `*.invoice_id`, `matched_invoice_id` | **none** | **blocks** (no archive design; they would dangle) |
| journal | its source record (DRC VAT → bill, auto-post offset → bank line, adjustment → reconciliation) | `gl_journal_entries.(source, source_record_id)` | **none** (polymorphic) | yes when the record is in the closure; otherwise **blocks** |
| any document | approvals, document links, UDF values, stock movements | `approval_requests.document_id`, `document_links.linked_entity_id`, `entity_udf_values.entity_id`, `stock_movements.reference_id` | **none** (polymorphic) | yes (snapshot) for approvals, links, UDFs; **blocks** for stock movements |
| journal line, invoice | account-merge log, sent-mail scan | `gl_account_merges.moved_line_ids`, `sent_mirror_scan_log.linked_invoice_ids` (uuid[]) | **none** (array) | ignored (history logs); recorded |
| journal | VAT return, payroll, assets, loans, stock, intercompany, expense claims, reclass, Sage ledger, UIF, tax directive, accounting adjustments, soft-delete reversals | §A1 | NO ACTION | **blocks** |
| quote, sales order, delivery note | invoice | §A1 | NO ACTION | **blocks** |

### 5.3 Keeping the edge list true

The edge list lives in one module (`archiveClosureEdges.ts`), and a census test reads `pg_constraint` on the fixture. Every FK into a movable table must be in the list as "in closure" or "blocks", or the test fails. A future migration that adds an FK into `customer_invoices` therefore cannot silently re-create R-053. The soft references in §A3 are covered by a second census over **every** uuid and uuid[] column with no FK, each classified in the edge module as an edge, a block or ignored (with a reason). A new unclassified column fails the test. So the build should also add real FKs for the soft edges it relies on (`customer_invoices.gl_journal_entry_id`, `credit_note_allocations.invoice_id`). That is two migrations, each with a census first.

---

## 6. D2 — Atomicity (R-192)

| Option | Verdict |
|---|---|
| a. Today's copy statement, then a delete-by-predicate statement | The defect. |
| b. R-186's pattern per table: `WITH moved AS (DELETE … WHERE <predicate> AND id = ANY(ids) RETURNING *) INSERT … SELECT FROM moved`, with counts | Necessary, but not enough. A journal posted or re-dated into the window between selection and move is still missed or caught late (R-186 fix.md, "FOR SHARE protects the invoice row only"). |
| **c. b plus `FOR UPDATE` on every closure member before the first move, one closure per savepoint (recommended)** | Rows that cannot change cannot drift. Locks follow the full canonical order in `bank/.claude.md` (reconciliations FOR SHARE → bank lines → payments → invoices → GL), with id order inside each tier. The kinds that have no tier yet (credit notes, write-offs, allocations, payment requests) need one assigned before the build. Waits are bounded by `withRowLockBudget`, with `ROW_LOCK_TIMEOUT` → 503 + Retry-After. The budget bounds the wait, not the number of rows, so a run moves one closure at a time rather than locking a company's whole history in one go. Soft-edge writers (`captured_documents.matched_invoice_id`, `time_entries.invoice_id`) take no lock on the invoice, so a FOR UPDATE cannot stop them. The blocking soft edges need real FKs, or those writers must lock the invoice, before C is safe. A closure that grows while it is locked (a new allocation is inserted) is caught by recomputing the closure under the lock and comparing it to the selected set (`ARCHIVE_SET_CHANGED`). |

Further rules:

- The archive `INSERT` has no `ON CONFLICT`. A duplicate id raises 23505, and the run fails whole.
- Journal lines move by journal id before their entries. The FK is CASCADE, so deleting entries first would drop lines with no copy.
- `trg_gl_jl_balance_update` decrements `gl_account_balances` when lines are deleted. No financial report reads that cache (`getAccountBalance` has no caller), but the natural-language query feature exposes the table (`nlQueryValidationService.ts:46`), so answers there change for archived periods. The roll-forward's own lines re-add the totals in each roll-forward's period. G2 covers it.
- The five unique indexes that stop double-booking (`uq_supplier_invoices_supplier_number`, `ux_customer_payments_card_reference`, `ux_gl_je_gateway_fee_reference`, `uq_gl_je_capture_source_document`, `uq_bank_tx_feed_identity`) see live rows only. After a move, the same bill, card receipt or feed line could be booked again, and a restore would then hit 23505. D1c's `archive_keys` table is the fix.
- `generate_journal_entry_number()` takes `MAX + 1` over live `JE-<calendar year>-%` rows, so after a move it can re-issue an archived number. A roll-forward dated in an archived calendar year would take one, and a restore would then collide on `uq_gl_je_company_entry_number`. D1c's high-water mark is the fix.

---

## 7. D4 + D5 — Archive storage and integrity (R-194, R-053)

| Option | Verdict |
|---|---|
| a. Keep the five mirror tables and add four more (items, views, disputes, dunning) | Rejected. It doubles the drift surface, which is already 105 columns (§A4), and still misses the next child table. |
| b. Refuse documents that have children | Rejected. Every invoice has items, so nothing would archive. |
| **c. One `archive_records` table of JSONB snapshots (recommended)** | `(company_id, run_id, kind, id, document_date, payload jsonb, payload_sha256, created_at)`, with PK `(company_id, kind, id)`. `payload` is `to_jsonb()` of the row plus its CASCADE and snapshot children, taken in the same statement as the delete. New live columns are captured automatically, so there is no drift. |

Integrity, under option c:

- `company_id NOT NULL REFERENCES companies`, `run_id NOT NULL REFERENCES archive_runs`.
- Forced RLS with the standard `tenant_isolation` policy (N1 shows why "standard" must be checked, not assumed).
- app_user gets `SELECT` only. Writes go through a `SECURITY DEFINER` function owned by a role with BYPASSRLS asserted (memory: RLS promotes the definer owner). A `BEFORE UPDATE OR DELETE` trigger refuses, except inside restore.
- No FKs to live tables. A live customer may later be merged or deleted, and the archive must not block that or be rewritten by it. The customer merge records a redirect (a new merge-redirect table; none exists today) instead of updating archived payloads (N4).
- Expression indexes for the Sage importers' lookups: `(company_id, kind, (payload->>'invoice_number'))` and `(company_id, kind, (payload->>'sage_invoice_id'))` (N4).
- `archive_runs` gains the counts the run already reports but cannot store (`invoices_skipped`, closures kept), and `restored_at` / `restored_by`.

The old five mirror tables are dropped once the §9 census shows them empty. Any rows found are converted into `archive_records` first, by a one-off migration whose census proves the counts match.

---

## 8. D6 — Reversibility and audit

| Option | Verdict |
|---|---|
| a. Irreversible | Simple, but a wrong cutoff is permanent. |
| **b. Restore the latest unrestored run only (recommended)** | Re-inserts the payloads in parent → child order, then posts the reversal of that run's roll-forwards. The column list is built from the catalog with GENERATED columns left out (`customer_invoices.balance` and `supplier_invoices.balance` are GENERATED ALWAYS, so inserting them raises 428C9). Columns added since the archive take their DEFAULT, not NULL. Restore runs under `isaflow.approval_gate_exempt`, because `supplier_invoice_approval_gate` would refuse a bill approved before enforcement was switched on. Merge redirects and `archive_keys` are resolved in a pre-flight. It refuses whole if any id now exists live, if any parent row is gone, or if a later run exists. Restore sets `archive_runs.restored_at`, keeps the `archive_records` rows (marked restored) for the audit trail, and is itself audited. |
| c. Restore any run | Rejected. Runs stack: an earlier run's roll-forward is folded into a later run's closure math. |

**Audit:** every run, refusal and restore writes `audit_log` (today's run already does, via `logAuditOrThrow`). `payload_sha256` per record plus a run-level hash on `archive_runs` gives tamper evidence for the retention obligation.

**Retention (N2):** Companies Act s24 (7 years) and Tax Administration Act s29 (5 years from the return, extended while an audit or objection is open) both require *keeping*. Archived rows stay retrievable, so archiving does not breach either. Purging is a different feature, governed by POPIA purpose limitation, and is out of scope here. If C is built, an erasure request against an archived record needs a path past the immutability trigger; that is an open decision (§2, D8). Frozen report packs alone would not answer a SARS s29 request for invoice-level records; the JSONB snapshots would.

---

## 9. D7 — Census (prod, read-only; Hein runs it, never from an agent)

```sql
-- 1. Has any run ever completed? (R-053, R-191, R-192; expected: none completed)
SELECT company_id, status, count(*), min(started_at), max(started_at) FROM archive_runs GROUP BY 1, 2 ORDER BY 1, 2;

-- 2. Rows in the mirror tables (expected 0 everywhere; non-zero means history already left the ledger)
SELECT 'je' t, count(*) FROM archive_gl_journal_entries UNION ALL SELECT 'jl', count(*) FROM archive_gl_journal_lines
UNION ALL SELECT 'bt', count(*) FROM archive_bank_transactions UNION ALL SELECT 'ci', count(*) FROM archive_customer_invoices
UNION ALL SELECT 'si', count(*) FROM archive_supplier_invoices;

-- 3. N1 exposure: archived lines with no tenant column (expected 0)
SELECT count(*) FROM archive_gl_journal_lines;

-- 4. D0 volume and timing: is there a performance case at all? Live rows per company and year,
--    then EXPLAIN (ANALYZE, BUFFERS) on the balance-sheet query for the company that tops this list.
SELECT je.company_id, date_part('year', je.entry_date) yr, count(*) lines
FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20;
SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_stat_user_tables
WHERE relname IN ('gl_journal_lines','gl_journal_entries','bank_transactions','customer_invoices','supplier_invoices');

-- 5. The registered censuses still apply: R-191, R-192, R-194, R-195, R-186 (their historicalDataImpact fields in backlog.json).
```

---

## 10. Re-enable gate (only if D0 = keep)

POST stays 403 until all of these pass on one head:

- **G1. FK census test** (§5.3) is green, and fails when a new FK is added on the fixture (mutation).
- **G2. Tie-out, against every tenant on a staging copy of prod:** for every account **and every dimension filter** (project, cost centre, cc1, cc2, business unit), the balance as at every date on or after the cutoff is identical before and after a run. TB rows (including `RE-BF`) are identical row by row, not only in total. Named cases: a VAT period straddling a fiscal year-end, a closure with a write-off, a year with a posted year-end close, a Paystack card receipt replayed after its closure moved, and AFS and board-pack comparatives. The same holds for the TB and income statement for every period after the cutoff, VAT201 for every period after the cutoff, aged debtors and creditors, and customer and supplier statements with a from-date on or after the cutoff. Reports before the cutoff are refused live and match the frozen pack.
- **G3. Race tests** for every moved table (the R-186 hook pattern), plus a lock-timeout case.
- **G4. Restore round-trip:** run, restore, and then every report is identical to before the run.
- **G5. Route:** `ARCHIVE_SET_CHANGED` and `ARCHIVE_CLOSURE_BLOCKED` map to 409, `ROW_LOCK_TIMEOUT` to 503 + Retry-After, and the refusal codes are registered in `REFUSAL_CODES`.
- **G6.** Browser proof of preview, run and restore. An adversarial review on every GL-writing PR.

---

## 11. Build shape (after D0–D7 are answered; not started)

**If D0 = retire (A):** one PR. Remove `executeArchive`, `archiveCustomerInvoiceScope`, the POST branch and the Archive Now UI remnants, and their tests. Keep `getStorageStats` if the page stays. Add a migration that drops the five mirror tables, guarded by a census `DO` block that raises if any has rows. Update `customerMergeService` and both Sage importers, which reference the dropped tables. Add the nav and `.claude.md` updates. R-053, R-191, R-192 and R-194 close as "removed".

**If D0 = keep (C), the task DAG is:**

1. N1 fix + `archive_records` + `archive_runs` columns (migration) → 2, 3
2. `archiveClosureEdges` + FK census test (G1) → 4
3. Soft-edge FKs (two migrations, census first) → 4
4. Closure engine: select, lock, and recompute under the lock (G3) → 5
5. Move + snapshot per kind (D2, D4) → 6
6. Roll-forward posting + frozen report pack (G2) → 7
7. Restore (G4) → 8
8. Route, UI, re-enable behind the gate (G5, G6); production deploy after hours with Hein's approval.

Steps 1–3 also need D1c's `archive_keys` + journal high-water mark (migration, before 5) and the soft-edge FKs or invoice locks from §6. Each step is one PR with a blind review, plus an adversarial review for 4–7.

---

## Appendix A — Schema census (fixture, master `470df5599`)

### A1. Foreign keys into the five relations the run deletes

Query (`pg_constraint`):

```sql
SELECT c.confrelid::regclass AS parent, c.conrelid::regclass AS child,
       (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols,
       CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                          WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete, c.conname
FROM pg_constraint c
WHERE c.contype = 'f' AND c.confrelid IN ('gl_journal_entries'::regclass, 'gl_journal_lines'::regclass,
      'bank_transactions'::regclass, 'customer_invoices'::regclass, 'supplier_invoices'::regclass)
ORDER BY 1, 4, 2, 3;
```

Totals: NO ACTION **40** (`gl_journal_entries` 28, `customer_invoices` 6, `supplier_invoices` 3, `gl_journal_lines` 2, `bank_transactions` 1); CASCADE 9; SET NULL 9.

| Parent | NO ACTION children (column) |
|---|---|
| gl_journal_entries | accounting_adjustments (gl_journal_entry_id), gl_journal_entries (late_claim_of_id), gl_journal_entries (reversal_of_id), supplier_invoices (gl_journal_entry_id), supplier_payments (gl_journal_entry_id), supplier_payments (settles_provisional_je_id), asset_depreciation_schedule, asset_disposals, credit_notes (gl_journal_entry_id), customer_payments (gl_journal_entry_id), customer_write_offs (gl_journal_entry_id), expense_claims (posted_je_id), gl_entry_date_corrections, gl_journal_document_links, intercompany_transactions (source_ and target_journal_entry_id), loan_payments, loan_reclass_postings, payroll_run_headers (journal_entry_id), reclassification_batch_lines (journal_entry_id), sage_ledger_transactions, soft_delete_journal_reversals, stock_adjustments, supplier_payment_batches, tax_directive_payments, uif_declarations, vat_adjustments, vat_returns |
| gl_journal_lines | bank_transactions (matched_journal_line_id), reclassification_batch_lines (source_line_id) |
| bank_transactions | ap_payment_document_backfill (bank_transaction_id) |
| customer_invoices | credit_notes, customer_payment_allocations, customer_quotes (converted_invoice_id), customer_sales_orders, customer_write_offs, delivery_notes |
| supplier_invoices | credit_notes, payment_allocations, supplier_payment_allocations |

| Parent | CASCADE children | SET NULL children |
|---|---|---|
| gl_journal_entries | gl_journal_lines, loan_reclass_backfill_refusals | bank_transactions (provisional_je_id), payroll_run_headers (posted_journal_entry_id) |
| bank_transactions | bank_feed_transaction_conflicts, bank_tx_queries | — |
| customer_invoices | customer_invoice_items, customer_invoice_views, customer_invoice_disputes, dunning_sends (R-194) | paystack_payment_requests, stitch_payment_requests (both + CHECK → 23514, R-186), sage_customer_invoices |
| supplier_invoices | supplier_invoice_items (**also lost today, not in R-194**) | expected_invoice_alerts, sage_supplier_invoices, supplier_coding_history, supplier_statement_lines |

Depth-2 closure (tables that reference the children above; recursive query over the same `pg_constraint` edges, depth ≤ 3): credit_notes ← credit_note_allocations (CASCADE); customer_payments ← customer_payment_allocations (CASCADE); supplier_payments ← payment_allocations, supplier_payment_allocations (CASCADE), ap_payment_document_backfill (SET NULL); customer_sales_orders ← delivery_notes (NO ACTION), customer_sales_order_items (CASCADE); intercompany_transactions ← consolidation_adjustments (NO ACTION); payroll_run_headers ← payroll_run_lines (CASCADE), payroll_loan_payments and payroll_loan_payment_reversals (SET NULL); expense_claims ← expense_claim_lines (CASCADE); customer_invoice_items ← customer_invoice_disputes (SET NULL); quotes, delivery notes ← their lines (CASCADE).

### A2. The archive tables themselves

| Table | company_id | FKs | RLS | app_user |
|---|---|---|---|---|
| archive_gl_journal_entries | nullable, FK companies | companies only | forced, tenant_isolation | S I U D |
| archive_gl_journal_lines | **absent** | **none** (not even to the archived entry) | **off** | S I U D (**N1**) |
| archive_bank_transactions | nullable, FK companies | companies only | forced | S I U D |
| archive_customer_invoices | nullable, FK companies | companies only | forced | S I U D |
| archive_supplier_invoices | nullable, FK companies | companies only | forced | S I U D |
| archive_runs | NOT NULL, FK companies | companies, users | forced | S I U D |

The goal file's summary of R-053 ("archive tables lack FKs/company_id"; the register title is about the run never completing) is accurate for `archive_gl_journal_lines`. The other four have a nullable `company_id` with an FK to companies and no other FK. Archived history is mutable by app_user in every table.

### A3. Soft references (no FK; name-based lead list)

```sql
SELECT c.table_name, c.column_name FROM information_schema.columns c
JOIN pg_class t ON t.relname = c.table_name AND t.relkind = 'r'
WHERE c.table_schema = 'public' AND c.table_name NOT LIKE 'archive\_%'
  AND (c.column_name ~ '(journal_entry_id|_je_id|journal_line_id|bank_transaction_id|bank_tx_id)$'
       OR c.column_name ~ '(^|_)invoice_id$')
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
                  WHERE k.contype = 'f' AND k.conrelid = t.oid AND a.attname = c.column_name);
```

16 rows by name. 14 point at a movable relation: `customer_invoices.gl_journal_entry_id` (R-191), `credit_note_allocations.invoice_id`, `payment_transactions.invoice_id`, `portal_payment_links.invoice_id`, `project_time_entries.invoice_id`, `time_entries.invoice_id`, `captured_documents.matched_invoice_id`, `captured_documents.matched_bank_tx_id`, `bank_allocation_batch_lines.bank_transaction_id`, `bank_allocation_batch_lines.journal_entry_id`, `bank_transaction_attachments.bank_transaction_id`, `ap_payment_document_backfill.journal_entry_id`, `loan_gl_postings.journal_entry_id`, `bank_transactions.transfer_journal_entry_id`. The other two are external ids (`supplier_invoices.sage_invoice_id`, `admin_invoices.stripe_invoice_id`). Not caught by name: the gateway fee journal, linked to its receipt by `reference`; the polymorphic `gl_journal_entries.source_record_id` (DRC VAT journal → bill, `drcVatService.ts:137`; auto-post offset → bank line, `autoPostHandOffset.ts:126`; adjustment → reconciliation), `approval_requests.document_id`, `document_links.linked_entity_id`, `entity_udf_values.entity_id` and `stock_movements.reference_id`; and the uuid[] arrays `gl_account_merges.moved_line_ids` and `sent_mirror_scan_log.linked_invoice_ids`. So a name-based census is a lead list only; §5.3 requires the full one.

### A4. Mirror-table drift (live columns with no archive column)

```sql
SELECT l.t, count(*) FILTER (WHERE a.column_name IS NULL) missing, count(*) live_cols
FROM (SELECT table_name t, column_name FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name IN ('gl_journal_entries','gl_journal_lines','bank_transactions','customer_invoices','supplier_invoices')) l
LEFT JOIN information_schema.columns a ON a.table_schema = 'public' AND a.table_name = 'archive_' || l.t AND a.column_name = l.column_name
GROUP BY 1;
```

| Table | Live columns | Not archived |
|---|---|---|
| bank_transactions | 48 | 31 |
| customer_invoices | 52 | 26 |
| supplier_invoices | 54 | 25 |
| gl_journal_entries | 35 | 15 |
| gl_journal_lines | 17 | 8 (incl. `vat_type`, `company_id`) |

### A5. Triggers on the deleted relations

Only `gl_journal_lines.trg_gl_jl_balance_update` (AFTER INSERT/UPDATE/DELETE → `update_account_balances`) fires on a delete. It decrements `gl_account_balances` for posted lines, a cache with no financial-report reader but exposed to the natural-language query feature (§6).

## Appendix B — Adversarial review of the draft (Opus, at `cad1aa985`, verdict FIX)

It confirmed every count in Appendix A, and that D0 = retire holds. Each finding was re-checked on the fixture or in the code before it was folded in.

| # | Finding | Disposition |
|---|---|---|
| 1 | H: P&L rolled into retained earnings breaks the TB `RE-BF` row and double-counts a closed year | §4.2b: P&L nets stay on P&L accounts, one roll-forward per archived year |
| 2 | H: the roll-forward collapses project / cost-centre / BU dimensions | §4.2b grouping; G2 per dimension |
| 3 | H: VAT fallback sweeps roll-forward lines; VAT periods straddle the year-end | own source excluded by VAT reports; cutoff must be a VAT-period start; G2 case |
| 4 | H: polymorphic and array references missed, so R-191 was not closed | §5.2 rows added; §5.3 full uuid/uuid[] census; A3 corrected |
| 5 | H: five unique guards see live rows only (double-booking after a move) | §6, D1c `archive_keys` |
| 6 | H: journal numbers re-issued (`MAX + 1` over live rows) | §6, D1c high-water mark (verified in `generate_journal_entry_number`) |
| 7 | M: restore fails on GENERATED `balance`, the approval gate, and NULL vs DEFAULT | §8 restore rules (verified: both `balance` columns are GENERATED ALWAYS) |
| 8 | M: "settled" undefined per kind; statements ignore write-offs | §5.1 per-kind table; §4.3 write-off rule (verified: no write-off term in `customerStatementRules.ts`) |
| 9 | M: comparatives fall before the cutoff | D1d: cutoff at least two fiscal years back |
| 10 | M: lock order incomplete; soft-edge writers take no lock | §6c |
| 11 | M: indexes don't bound from-inception scans; closed-year snapshots under-weighted | §2 D0 rationale; §9 query 4 adds EXPLAIN ANALYZE |
| 12 | L: R-053 title misquoted; NL query reads `gl_account_balances` | A2, §6, A5 corrected |
| 13 | L: missing decisions (who runs it, attachments, POPIA erasure, SARS s29, cross-company neighbours, R-195) | D1d, D8, D9, §5.1, §8 |
