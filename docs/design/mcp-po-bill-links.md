# MCP: purchase order ↔ bill links (section 2 of the 19 Nov PO brief)

Why: Velocity's Sage data carries 827 bill→PO links (`FromDocument`) on 628 POs; 813 resolve to IsaFlow bill ids. They
must load right after the 757 POs (#1591) without reposting a single bill. Section 1 (items) is PR #1604, another
session; sections 4, 3, 5 follow this PR.

## What exists

- `supplier_invoices.purchase_order_id` — ONE PO per bill, no FK (older rows may name `supplier_purchase_orders`).
- `supplier_invoice_items.po_item_id` — a bill line's PO line. Budget committed (`budgets/remainingCommitted`) nets a
  PO line by the posted ex-VAT of every linked bill line on an approved / paid / partially_paid bill; the three-way
  match (`ap/threeWayMatchState`) judges each line against its PO line and GRN line.
- Only the REST create writes either column today (`ap/supplierInvoicePoLinks.assertBillPoLinks`).

## Decisions

1. **New table `purchase_order_bill_links`** (migration `1006`): one row per (company, PO, bill). Columns: `id`,
   `company_id`, `purchase_order_id` (FK purchase_orders), `supplier_invoice_id` (FK supplier_invoices), `amount`
   NUMERIC(19,2) NOT NULL (ex-VAT billed against this PO), `source` (`mcp` | `app` | `backfill`), `external_system`,
   `external_ref`, `closed_po_from_status` (set when this link's call closed the PO), `created_by`, `created_at`.
   UNIQUE (company_id, purchase_order_id, supplier_invoice_id); UNIQUE (company_id, external_system, external_ref)
   where ref is present. RLS on company_id like the other tenant tables. A bill may link several POs (Sage does).
2. **Line links reuse `supplier_invoice_items.po_item_id`.** That way committed, the three-way match and the bill page
   pick them up with no new reader. One bill line → one PO line, whole line (no splitting a bill line across PO lines:
   the brief's per-link qty/amount is the bill line's own). A bill line already naming another PO line is refused.
3. **Header column kept in step:** `supplier_invoices.purchase_order_id` = the bill's PO when it has exactly one link,
   else NULL. The three-way read takes PO lines from the lines' own `po_item_id`, so a multi-PO bill still matches.
4. **Link amount** (stored, so a bill's split never changes later): the explicit `amount`; else the posted ex-VAT of
   the bill lines linked to this PO in the same call; else the bill's ex-VAT subtotal less what its other links
   already hold. Refused when it would be ≤ 0 or take a bill's links past its subtotal (+1c).
5. **Billed** for a PO = Σ link amounts on bills in approved / paid / partially_paid. Per PO line: billed qty and
   amount from linked bill lines (`billedLinesByPoItem`, the same posted amounts committed uses). Computed on read;
   nothing is rolled up into `po_items`, so there is nothing to drift.
6. **Fully billed** = billed ≥ PO subtotal − 1c (Hein, 19 Nov). Status is left alone unless the call passes
   `close_when_fully_billed: true` (Hein, 19 Nov); then an approved / partially_received / received PO that is fully
   billed moves to `closed` and the link records the status it came from. Every response reports `fully_billed`.
7. **No ledger effect.** Linking never touches `gl_journal_*`, bill status, amounts or `amount_paid`. Tested.
8. **Allowed:** PO approved / partially_received / received / closed (the Sage Invoiced POs import as closed);
   refused: draft, submitted, cancelled. Bill: any status but cancelled. Same company, same supplier (cross-supplier
   refused).
9. **Idempotency:** a pair already linked with the same (external_system, external_ref) → `already_existed`; a pair
   already linked otherwise → refused ("already linked"); an external_ref already used on another pair → refused.
10. **Unlink** (`unlink_bill_from_purchase_order`): deletes the link, clears `po_item_id` on that bill's lines that
    point into this PO, resets the header column per decision 3, and reopens the PO to `closed_po_from_status` when this
    link closed it and it is still closed. A reason is required; audited.
11. **Backfill + app writer:** the migration inserts a `backfill` link for each non-cancelled bill whose
    `purchase_order_id` names a canonical PO of the same company and supplier (amount per decision 4). The REST create
    inserts a `source = 'app'` link when it saves a bill with a canonical `purchase_order_id`, so the table stays the
    one list of links.
12. **Scope `write:invoices`** (as `bulk_create_purchase_orders`): a new scope would need every connector re-consented
    before the migration can run.
13. **Locks:** PO rows `FOR UPDATE` in id order, then bill rows in id order, all inside one savepoint, 5 s budget
    (`withRowLockBudget`). Lock-order census against bill approve / cancel, PO approve / cancel and goods receipt is
    in the PR.

## Tools

- `link_bills_to_purchase_order` — `links` ≤ 200: `{ po_id | po_number, bill_id, amount?, lines?: [{ po_item_id,
  bill_line_id }], external_system?, external_ref? }`, `close_when_fully_billed?`, `dry_run?`, `idempotency_key`.
  All or nothing; every bad row is listed with its reason. One audit row per link (entity purchase_order).
- `unlink_bill_from_purchase_order` — `{ po_id | po_number, bill_id, reason, dry_run?, idempotency_key }`.
- `get_purchase_order` (read) — `po_id | po_number`: header, lines (ordered / received / billed qty and amount,
  outstanding), linked bills, GRNs, documents, billed total, `fully_billed`.
- `list_supplier_invoices` / `get_supplier_invoice` gain `purchase_order_ids`; `get_supplier_invoice` gains
  `three_way` (status fully_matched / po_matched / grn_matched / unmatched and per-line variances).
- `find_by_external_ref` gains kind `po_bill_link`.

## Known limits

- A header-only link (no line links) does not reduce budget committed for a still-open PO; only line links and
  closing the PO do. Section 5 (`committed_spend`) decides whether committed should net header links too.
- No splitting one bill line across PO lines.
