# PO <-> bill links: one-off backfill re-run (migration 1032)

Status: proposed. Follow-up to PR #1703 / migration 1006 (`docs/design/mcp-po-bill-links.md`, item 11).

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
left alone. Two limits, stated so nobody is surprised: (1) a pair a user UNLINKED since 1006 is re-linked (the unlink deletes the row;
the backfill cannot tell it from a bill never linked); (2) a bill whose header was re-pointed from PO A to PO B by a writer other than the app keeps its `backfill` link to A and gains one
to B: the function counts only links it does not own when it sizes a header-only PO, so A + B can exceed the bill's subtotal (probed on the
throwaway database: A 100.00 and B 100.00 on a 100.00 bill). The app's own sync remakes a draft's links on its next edit and unlinking removes
one, so this needs a non-app header edit of a bill that already carried a backfill link; it is the function's behaviour since 1006/1022 and this
migration does not change it (a change would be a function redefinition and its own design decision). The integration test proves the normal
shapes stay within the subtotal.

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
draft bill, draft PO, other-supplier PO, other company's PO, a bill already holding an mcp link. The migration file's SQL runs as the
suite's `postgres` inside a transaction that is rolled back (a global run must not write into other suites' fixtures). Asserts: links exactly
as the rules say; a second run writes 0; every bill's links sum to at most its subtotal; the other company's pre-existing link is unchanged;
no table lock above ROW EXCLUSIVE. Mutants (copies of the live function with one line changed) must each fail the same checks.
