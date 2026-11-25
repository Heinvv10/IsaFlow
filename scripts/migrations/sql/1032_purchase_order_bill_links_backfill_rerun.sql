-- 1032: re-run the purchase-order <-> bill links backfill once, for every company, now that the #1703 engine is live.
-- Design: docs/design/po-bill-links-backfill.md. Function: purchase_order_bill_links_backfill(UUID) (1006, redefined by 1022).
--
-- WHAT. One call, all companies. A bill created or edited before the new code wrote its `app` links (or by the old colour between
-- 1006 and the switch) has no link until this runs; 1006's header asks for exactly this re-run after the release. It writes only
-- `backfill` links, ON CONFLICT DO NOTHING on (company, PO, bill): idempotent, a second run writes 0, an existing link of any source is
-- never touched. No DDL, no function change (so no definer-registry row), no GL row, no change to a bill or a PO.
--
-- LOCKS. Reads, then INSERTs into purchase_order_bill_links (ROW EXCLUSIVE): no LOCK TABLE, no DDL, no FOR UPDATE. The foreign keys take
-- FOR KEY SHARE on the linked company / PO / bill rows until this file's transaction commits; that conflicts only with a DELETE or key
-- change of those rows. lock_timeout bounds a wait behind such a transaction; statement_timeout bounds the loop. On either the file
-- fails whole, nothing is written, and the release retries.
--
-- Rollback (not part of the migration; as the migration role; links are metadata and no ledger row depends on them):
--   DELETE FROM public.purchase_order_bill_links WHERE source = 'backfill';

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

SELECT public.purchase_order_bill_links_backfill();
