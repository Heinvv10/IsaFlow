# PO <-> bill links backfill: remainder rule fix and one-off re-run (migration 1032)

Status: built (migration 1032). Follow-up to PR #1703 / migration 1006 (`docs/design/mcp-po-bill-links.md`, item 11).

## Why

1006 backfilled `purchase_order_bill_links` once, when it was applied, and its header says to re-run
`SELECT purchase_order_bill_links_backfill();` once after the release goes live: a bill created or edited
before the new code wrote `app` links has no link until then. 1022 redefined the function (BRK-B: one rand to one PO)
and calls it per company, but only for companies that had a legacy `supplier_purchase_orders` row to copy; prod had none
(project_status, 2026-11-22), so no company has had a run since the function's final shape went live. Nothing else
calls it (`git grep purchase_order_bill_links_backfill`: 1006, 1022, tests, docs). Not already done, so this PR is needed.

Review found a double count in the function as 1022 left it, and a re-run would spread it, so 1032 fixes the function first.

## The defect and the fix

1022 sized a header-only (or zero-posting) PO as the subtotal less the links this writer does NOT own (mcp, or with an external reference).
A stale `backfill` / `app` link to ANOTHER PO (the header was re-pointed outside the app; no line names that PO) was not subtracted, so the
header PO got the full subtotal beside it: A 100.00 + B 100.00 on a 100.00 bill (probed on the throwaway database).

Fix, in the function (`CREATE OR REPLACE`, 1022's body verbatim except one clause): the remainder now subtracts every link the bill already has on
a PO its lines do not name, of **any source**. Arithmetic: header PO = subtotal - posted cents of the lines' POs - existing links elsewhere, never <= 0.

| bill (subtotal 100) | existing link on a PO the lines do not name | header PO gets |
|---|---|---|
| plain header-only | none | 100.00 |
| re-pointed header | stale backfill 100.00 | none (remainder 0) |
| re-pointed header | stale app 30.00 | 70.00 |
| mcp link 30.00 (unchanged by this fix) | mcp 30.00 | 70.00 |

A bill's links therefore sum to at most its subtotal by arithmetic, not by a heuristic. A link on a PO the lines DO name is still not
subtracted (the lines account for it, 1022 BRK-B). **Remainder, not skip** (the orchestrator's rule allowed either): a skip rule ("no link while the bill holds
any link elsewhere") would also drop the 30.00 mcp case above, which `mcp-po-bill-links-amounts` pins as 70.00 in SQL and TypeScript alike, and it
under-attributes a bill that is genuinely split between two POs. The remainder gives the same answer as a skip whenever the existing
links already cover the subtotal (the double-count case) and never attributes more than is unlinked.

Divergence from the app, named: the TypeScript sync (`billPurchaseOrderLinks.planBillLinks`) subtracts only links it does not own, because it first remakes
its own links on a draft edit. The backfill never touches an existing link, so it subtracts those too and is the more conservative of the two where a
stale owned link exists (no other case differs; `mcp-po-bill-links-amounts` still holds the two equal to the cent).

Known disagreement with the app sync, named: an APPROVED bill with header B and a stale app / backfill link of 100.00 on A keeps that link, because the app sync
only remakes a bill's links while it is a draft, so an approved bill is never re-synced; the backfill does not touch it either (no link to B, remainder 0).
Until someone unlinks it, the 100.00 stays attributed to A although the header names B: A's committed spend is understated (the bill reduces it) and B's is
overstated (nothing reduces it). Both states attribute 100.00 in total, which is the invariant; 1022 would have attributed 200.00. The unlink tool
(`unlink_bill_from_purchase_order`) clears the stale link.

The function stays SECURITY INVOKER with the same signature, `search_path`, owner and grants (CREATE OR REPLACE keeps the ACL; the integration test
asserts not a definer, no execute right for app_user / app_service). So no `app_definer_reviews` row (the definer registry is for SECURITY DEFINER).

## What 1032 does

`scripts/migrations/sql/1032_purchase_order_bill_links_backfill_rerun.sql`: `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '300s'`,
the redefinition, then one `SELECT public.purchase_order_bill_links_backfill();` (all companies). The function emits
`RAISE NOTICE '... N link(s) written, M skipped'`.

Number: highest on `origin/master` is 1031 (numeric order, letter suffixes included); open PRs hold 1023, 1024, 1040, 1041.
1032 is free on both and sorts after 1022, whose function it replaces.

**Release timing.** 1032 is a pending migration like any other: it ships with the next auto-release after hours; `deploy.sh` refuses to apply a pending
migration on a weekday 08:00-17:00 (the daytime migration gate), and this PR changes nothing about that.

## What it writes

Only rows of `purchase_order_bill_links` with `source = 'backfill'` and `external_ref IS NULL`: per non-cancelled,
non-deleted bill, per PO that the bill's header or lines name, of the same company and supplier, PO status approved /
partially_received / received / closed. Amount: the posted ex-VAT cents of the lines naming the PO (capped at the subtotal), or
for a header-only / zero-posting PO the remainder above, never <= 0. It writes nothing else: no GL row, no change to a bill, a PO or a line.

## Idempotency and limits

`INSERT ... ON CONFLICT (company_id, purchase_order_id, supplier_invoice_id) DO NOTHING`: a pair that already has a link
(any source) is never touched, so a second run writes 0 and a link an operator or the app made is left alone.

1. **Unlinked pairs stay unlinked.** A user's unlink (`purchaseOrderBillUnlink.ts`) deletes the link row, clears `po_item_id` on the bill's lines
   into that PO and resets the bill's header when it names the PO (`syncBillHeaderPurchaseOrder`), so the backfill's candidate query (header
   or a line names a PO) finds nothing to re-link. The unlink is audited (`audit_trail`, `link_removed`). A bill changed outside the app so
   that it names the PO again is a candidate again, like any other.
2. **Old amounts stay.** The re-run does not correct links 1006 sized under the old pre-BRK-B `held_c` rule (before 1022 stopped subtracting a
   link on a PO the bill's lines name), nor a stale link itself: `ON CONFLICT DO NOTHING` leaves every existing link as it is. The fix stops the
   backfill adding a second full amount; it does not remove the stale link.

### Evidence for release-lead: read-only count before the release

Bills the remainder rule will treat differently from 1022 (header PO not yet linked, but the bill holds an app / backfill link elsewhere that no
line names): the count shows how many bills the fix holds back or part-fills. Not a gate; the fix makes the run safe at any count. Run read-only on prod:

```sql
SELECT si.company_id, count(*) AS bills
  FROM supplier_invoices si
  JOIN purchase_orders hp ON hp.id = si.purchase_order_id AND hp.company_id = si.company_id AND hp.supplier_id = si.supplier_id
                         AND hp.status IN ('approved', 'partially_received', 'received', 'closed')
 WHERE si.status <> 'cancelled' AND si.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM purchase_order_bill_links lb WHERE lb.supplier_invoice_id = si.id AND lb.purchase_order_id = hp.id)
   AND EXISTS (SELECT 1 FROM purchase_order_bill_links la
                WHERE la.company_id = si.company_id AND la.supplier_invoice_id = si.id AND la.purchase_order_id <> hp.id
                  AND la.source IN ('app', 'backfill') AND la.external_ref IS NULL
                  AND NOT EXISTS (SELECT 1 FROM supplier_invoice_items x JOIN po_items pi ON pi.id = x.po_item_id
                                   WHERE x.supplier_invoice_id = si.id AND pi.purchase_order_id = la.purchase_order_id))
 GROUP BY si.company_id;
```

After the run a bill in this shape is still listed while its header PO stays unlinked (remainder 0, e.g. stale 100.00 on a 100.00 bill) and drops out
once it is part-filled (stale 30.00 gets 70.00), which the integration test asserts.

## Rollback

Not part of the migration (links are metadata; nothing depends on them, no ledger row). As the migration role: put 1022's definition back
(its section 1b) and `DELETE FROM purchase_order_bill_links WHERE source = 'backfill';` (this also removes those 1006 wrote, which a re-run restores).
Migrations are not rolled back by `rollback-deploy.sh`; the links stay and are harmless.

## Large prod table, locks, time

- Candidate bills are only those naming a PO (header or a line's `po_item_id`). The plan has no bills x POs shape (every join is on a key;
  `mcp-po-bill-links-backfill.int` EXPLAINs the live function's query under three join-method regimes at 600 bills x 300 POs).
- It runs as the file's single transaction (the runner's `BEGIN`..`COMMIT`). The function loops once per link, each insert in its
  own sub-transaction (`BEGIN .. EXCEPTION`), so a row that changed under the run is skipped with a WARNING, never aborts it.
- Table locks: `CREATE OR REPLACE FUNCTION` locks the function row only. The call reads (ACCESS SHARE) and inserts into `purchase_order_bill_links`
  (ROW EXCLUSIVE, which does not conflict with readers or other writers). It issues no `LOCK TABLE`, no table DDL, no `FOR UPDATE`. The row locks are the
  foreign keys' `FOR KEY SHARE` on the company, PO and bill rows it links, held to commit: they conflict only with a DELETE or key change of that row (and
  `FOR UPDATE`; the link tools take `FOR NO KEY UPDATE`, which does not). Status / amount edits of a PO or bill proceed. The integration test asserts, from
  `pg_locks`, that no table lock above ROW EXCLUSIVE is held by the run, and a mutant that adds one is caught.
- `lock_timeout 5s` bounds a wait behind a conflicting transaction; `statement_timeout 300s` bounds the loop (1006 used 120 s for its own
  file). On either, the file fails whole, nothing is written, and the release retries; the backfill is safe to retry.

## Tests (`tests/integration/po-bill-links-backfill-rerun.int.test.ts`)

The definition under test is read from the 1032 file, not from the database: `budgets-committed-breaker-r2` installs 1022's definition into the shared
database, so whatever is live depends on file order.

Two companies, bills without links (raw inserts, so no app sync ran): header-only, line-linked, line + header split, cancelled, soft-deleted,
draft bill, draft PO, other-supplier PO, other company's PO, a bill already holding an mcp link, an mcp link on a PO that no line names (held), one on a PO
the lines name (not held), a header PO plus two zero-posting line POs (lowest id takes the residual), a stale backfill link of 100.00 (header PO gets none),
a stale app link of 30.00 (header PO gets 70.00), and an owned link on a PO the lines name (not subtracted). The migration file's SQL runs as the suite's
`postgres` inside a transaction that is rolled back (a global run must not write into other suites' fixtures). Asserts: links exactly as the rules say; a second
run writes 0; every bill's links sum to at most its subtotal; the other company's pre-existing links are unchanged; no table lock above ROW EXCLUSIVE.
Mutants (the file's function source with one clause changed) must each fail the same checks, including the old rule (owned links not subtracted).
A separate test runs the stale cases and the query above in a rolled-back transaction.
