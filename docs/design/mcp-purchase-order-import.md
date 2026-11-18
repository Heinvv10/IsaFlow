# MCP purchase-order import (Sage PO migration)

Brief: `~/briefs/brief-isaflow-po-migration-mcp-20261118.md`. Velocity Fibre's 757 Sage POs, PO0000197 to PO0000953,
keep their numbers, then each gets its Sage PDF attached.

## Tools

- `bulk_create_purchase_orders` (write:invoices, ≤100 per call). It posts nothing and is all or nothing:
  - parse, price and ownership-check every element;
  - then write inside one savepoint;
  - `dry_run` runs every step and rolls back.
- `list_purchase_orders` (read:invoices). Returns:
  - number, supplier, status, totals, line count;
  - `has_document`;
  - external ref.

  It filters by number, status (one or several), supplier, order dates and external ref, offset-paged on
  (po_number, id).
- `find_by_external_ref` takes kind `purchase_order` or the Sage code `po`.
- Documents: `purchase_order` is an entity type for `attach_entity_document`, `list_documents` and the
  `create_upload_urls` / `finalize_uploads` targets (10 MB, PDF/JPEG/PNG/DOCX/XLSX), with default document type
  `purchase_order`. The RLS on `procurement_documents` has had a purchase_order branch since 497/713. Only the code
  whitelists and the upload-intent CHECK lacked it.

## Decisions

| Question | Decision |
| --- | --- |
| Which table | `purchase_orders` / `po_items`: what the PO pages, budgets (committed), the bill-to-PO link and the documents read. `supplier_purchase_orders` is a separate legacy pair that none of them read. |
| Number | Taken as sent. In-batch repeats are refused. A number already on another PO of the company refuses the batch, so a number is never reissued. |
| Re-run | Idempotent on (external_system, external_ref), **in any status**: a cancelled Sage PO sent again is the same PO, not a duplicate. A match comes back `already_existed`, with `payload_differs` when its number, date or total differ. Nothing is changed. |
| Status | `draft`; `open` = `approved`; `billed` = **`closed`** (new); `cancelled`. Sage mapping: Pending/Overdue → open, Invoiced → billed, Cancelled → cancelled. `partially_received` / `received` are refused: they come from goods receipts, and none exist for imported POs. |
| Invoiced POs must not be committed | A new status, `closed`. Committed spend (`COMMITTING_PO_STATUSES`), the bill-line link list, the bank-match payable list and the unmatched list are all allowlists without it. Edit, cancel and delete accept only other statuses, so a closed PO is read-only. Mapping Invoiced to `received` would have counted every Invoiced PO as open commitment, because the Sage bills are not linked by `po_item_id`. |
| Open POs and the budget | An open PO is approved through the same check the Approve action runs (channel `mcp`, company budget lock held once). Under block, an over-budget PO refuses the batch, so the import is no way around the control. Under warn, `budget_warnings` are returned. No `refused` event is recorded: the PO it would name was rolled back (954's FK trigger). |
| Amounts | po_items keeps quantity and unit price to 2 decimals. Lines may send the source's own `line_total` / `tax_amount` (Sage Exclusive/Tax), which are stored as sent. VAT must agree with them within 2 cents. Otherwise amounts are computed (exclusive, or `inclusive: true` the way an inclusive document rounds). `expected_totals` must equal the lines' sums to the cent. |
| Counter | The import locks the `purchase_order` counter row first (5 s budget → `ROW_LOCK_TIMEOUT`), as every PO writer does before inserting. That lock also serialises the "number exists?" check. Afterwards `next_number = GREATEST(next_number, max imported + 1)`, for numbers of the counter's own form (prefix + digits). After PO0000953 the app's next PO is PO0000954. |
| Scope | Existing `write:invoices` / `read:invoices`. A new scope would force every connector to re-consent. |
| Price | Free (`null` in flow metering): a PO is a commitment and bills nothing. **Owner's call**: the bulk invoice creates cost 3 Flows each. |
| Lock order | 1. budget gate (only if an open PO is in the batch); 2. counter row; 3. advisory lock per external ref, sorted. The same order as approval: gate first. |

## Not in scope / known limits

- **Linking POs to bills:** nothing links imported POs to the Sage bills. Closed POs are kept out of committed spend
  by their status. `quantity_received` / `quantity_invoiced` stay 0.
- **App list cap:** `/api/accounting/purchase-orders` (the app's list) returns at most 200 rows. With 757 POs the
  page shows the newest 200 per tab. That is a separate, existing limit.
- **Re-runs don't update:** a re-run never updates a stored PO. A corrected Sage PO shows as `payload_differs` and
  must be fixed in the app.
