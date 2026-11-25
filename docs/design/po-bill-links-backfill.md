# PO <-> bill links: one-off backfill re-run (migration 1032)

Status: built (migration 1032). Follow-up to PR #1703 / migration 1006 (`docs/design/mcp-po-bill-links.md`, item 11).

## Why

1006 backfilled `purchase_order_bill_links` once, when it was applied, and its header says to re-run
`SELECT purchase_order_bill_links_backfill();` once after the release goes live: a bill created or edited
before the new code wrote `app` links has no link until then. 1022 redefined the function (BRK-B: one rand to one PO)
and calls it per company, but only for companies that had a legacy `supplier_purchase_orders` row to copy; prod had none
(project_status, 2026-11-22), so no company has had a run since the function's final shape went live. Nothing else
calls it (`git grep purchase_order_bill_links_backfill`: 1006, 1022, tests, docs). Not already done, so this PR is needed.

## What

`scripts/migrations/sql/1032_purchase_order_bill_links_backfill_rerun.sql`: `SET LOCAL lock_timeout = '5s'`,
`SET LOCAL statement_timeout = '300s'`, then one `SELECT public.purchase_order_bill_links_backfill();` (all companies).
No DDL, no function change (so no `app_definer_reviews` row: the function is SECURITY INVOKER, and 1032 neither creates
nor alters any function). The function body already emits `RAISE NOTICE '... N link(s) written, M skipped'`.

Number: highest on `origin/master` is 1031 (numeric order, letter suffixes included); open PRs hold 1023, 1024, 1040, 1041.
1032 is free on both and sorts after 1022, whose function it calls.

## What it writes

Only rows of `purchase_order_bill_links` with `source = 'backfill'` and `external_ref IS NULL`: per non-cancelled,
non-deleted bill, per PO that the bill's header or lines name, of the same company and supplier, PO status approved /
partially_received / received / closed. Amount: the posted ex-VAT cents of the lines naming the PO (capped at the subtotal), or
for a header-only PO the subtotal less the other POs' lines and less links the function does not own, never <= 0. It
writes nothing else: no GL row, no change to a bill, a PO or a line.

## Idempotency

`INSERT ... ON CONFLICT (company_id, purchase_order_id, supplier_invoice_id) DO NOTHING`: a pair that already has a link
(any source) is never touched, so a second run writes 0 and a link an operator or the app made or unlinked-and-remade is
left alone. Limits, stated so nobody is surprised:

1. **Unlinked pairs stay unlinked.** A user's unlink (`purchaseOrderBillUnlink.ts`) deletes the link row, clears `po_item_id` on the bill's lines
   into that PO and resets the bill's header when it names the PO (`syncBillHeaderPurchaseOrder`), so the backfill's candidate query (header
   or a line names a PO) finds nothing to re-link. The unlink is audited (`audit_trail`, `link_removed`). A bill changed outside the app so
   that it names the PO again is a candidate again, like any other.
2. **A stale link beside a re-pointed header (named, not fixed).** A bill whose header was re-pointed from PO A to PO B by a writer other than
   the app, with a `backfill` / `app` ref-less link to A that no line names and no link to B, keeps A and gains B: the function subtracts only
   links it does not own when it sizes a header-only PO, so A + B can exceed the bill's subtotal (probed on the throwaway database: A 100.00 and
   B 100.00 on a 100.00 bill; pinned by the integration test "known limit"). The app's own sync remakes a draft's links on its next edit. It is
   the function's behaviour since 1006/1022; this migration does not change it (a change is a function redefinition and its own design decision).
   Before the deploy, anyone with prod read access can count the bills in that shape (rows per company; empty = the limit cannot bite):

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
3. **Old amounts stay.** The re-run does not correct links 1006 sized under the pre-BRK-B `held_c` rule (before 1022 stopped subtracting a
   link on a PO the bill's lines name): `ON CONFLICT DO NOTHING` leaves every existing link as it is.

## Rollback

Not part of the migration (links are metadata; nothing depends on them, no ledger row). As the migration role:
`DELETE FROM purchase_order_bill_links WHERE source = 'backfill';` removes every backfill link (it also removes those 1006 wrote,
which a re-run restores). Migrations are not rolled back by `rollback-deploy.sh`; the links stay and are harmless.

## Large prod table, locks, time

- Candidate bills are only those naming a PO (header or a line's `po_item_id`). The plan has no bills x POs shape (every join is on a key;
  `mcp-po-bill-links-backfill.int` EXPLAINs it under three join-method regimes at 600 bills x 300 POs).
- It runs as the file's single transaction (the runner's `BEGIN`..`COMMIT`). The function loops once per link, each insert in its
  own sub-transaction (`BEGIN .. EXCEPTION`), so a row that changed under the run is skipped with a WARNING, never aborts it.
- Table locks: the function reads (ACCESS SHARE) and inserts into `purchase_order_bill_links` (ROW EXCLUSIVE, which does not conflict with
  readers or other writers). It issues no `LOCK TABLE`, no DDL, no `FOR UPDATE`. The row locks are the foreign keys' `FOR KEY SHARE` on the
  company, PO and bill rows it links, held to commit: they conflict only with a DELETE or key change of that row (and `FOR UPDATE`; the link tools take
  `FOR NO KEY UPDATE`, which does not). Status / amount edits of a PO or bill proceed. The integration test asserts, from `pg_locks`, that no
  table lock above ROW EXCLUSIVE is held by the backfill's transaction (evidence in the PR).
- `lock_timeout 5s` bounds a wait behind a conflicting transaction; `statement_timeout 300s` bounds the loop (1006 used 120 s for its own
  file). On either, the file fails whole, nothing is written, and the release retries; the backfill is safe to retry.

## Tests (`tests/integration/po-bill-links-backfill-rerun.int.test.ts`)

Two companies, bills without links (raw inserts, so no app sync ran): header-only, line-linked, line + header split, cancelled, soft-deleted,
draft bill, draft PO, other-supplier PO, other company's PO, a bill already holding an mcp link, an mcp link on a PO that no line names (held), one on a PO the lines name (not held), and a header PO plus two zero-posting line POs (lowest id takes the residual). The migration file's SQL runs as the
suite's `postgres` inside a transaction that is rolled back (a global run must not write into other suites' fixtures). Asserts: links exactly
as the rules say; a second run writes 0; every bill's links sum to at most its subtotal; the other company's pre-existing link is unchanged;
no table lock above ROW EXCLUSIVE. Mutants (copies of the live function with one clause changed) must each fail the same checks; a separate test pins limit 2 above and runs the query above against it.
