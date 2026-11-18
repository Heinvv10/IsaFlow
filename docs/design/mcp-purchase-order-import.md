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
| Amounts | Lines may send the source's own `line_total` / `tax_amount` (Sage Exclusive/Tax), stored as sent. A line amount may be below quantity × unit price (a discount) and above it by at most 0.5% (or a cent): a source price truncated on an inclusive document fits, while Sage's VAT-inclusive Total sent as Exclusive (15% over) is refused. VAT must agree with the line within 2 c. Otherwise amounts are computed: exclusive, or `inclusive: true` rounding as an inclusive document does. `expected_totals` must equal the lines' sums to the cent. Quantity has at most 2 decimals; a line and a PO total stay within NUMERIC(15,2). |
| Unit price | The stored unit price is the line's effective ex-VAT price (line amount / quantity, the 6-decimal value that rounds back to it; 1001 widens `po_items.unit_price` to NUMERIC(19,6)). The app's PO edit and a bill's "copy lines from PO" re-derive amounts from quantity × price, so they keep a discounted or 4-decimal line's amount. Past about 10 000 units no 6-decimal price may round back exactly: the nearest is stored (never refused) and a re-derivation can differ by up to quantity × R0.0000005 (R0.50 at a million units); the stored line_total, which every PO figure reads, is unaffected. A discounted line shows its discounted unit price. |
| Counter | The import locks the `purchase_order` counter row first (5 s budget → `ROW_LOCK_TIMEOUT`), as every PO writer does before inserting. That lock also serialises the "number exists?" check. Afterwards `next_number = GREATEST(next_number, max imported + 1)`, for numbers of the counter's own form (prefix + digits). After PO0000953 the app's next PO is PO0000954. |
| Scope | Existing `write:invoices` / `read:invoices`. A new scope would force every connector to re-consent. |
| Price | Free (`null` in flow metering): a PO is a commitment and bills nothing. **Owner's call**: the bulk invoice creates cost 3 Flows each. |
| Lock order | 1. budget gate (only if an open PO is in the batch); 2. counter row; 3. advisory lock per external ref, sorted. The same order as approval: gate first. |

## Not in scope / known limits

- **Linking POs to bills:** nothing links imported POs to the Sage bills. Closed POs are kept out of committed spend
  by their status. `quantity_received` / `quantity_invoiced` stay 0.
- **Partly invoiced POs:** a Sage PO partly invoiced and imported as open counts in full as committed, while its Sage
  bills also count as actual, until a person closes or cancels it.
- **Re-runs never update:** a stored PO is never changed by a re-run. A changed number, date, total or status shows in
  `differences` (`payload_differs: true`) and must be fixed in the app. Closing an approved PO has no tool and no app
  action (Cancel makes it cancelled); that is a follow-up if Sage POs move from Pending to Invoiced after the load.
- **No negative lines:** discount or rebate lines with negative amounts are refused, and a document-level discount
  fails `expected_totals`. Fold such a discount into the lines' `line_total`.
- **No item lines:** `item_id` is not accepted. `po_items.product_id` references `products`, and no MCP tool returns
  products ids (`list_items` reads the separate `items` catalogue).
- **Existing app writers re-derive:** the PO edit (draft / submitted only, so no imported Sage PO but a draft) recomputes
  each line's VAT from its rate, replacing a Sage VAT kept within the 2 c tolerance, and rounds with plain float
  arithmetic, which can lose a cent at 10 000+ units. A bill keeps unit prices at 2 decimals (`supplier_invoice_items`):
  a bill copied from a PO line priced below about R0.25 can show a three-way price variance, and a later edit of that
  bill draft re-prices from the rounded price. The bill's price input now takes any precision (`step="any"`, so a
  copied price does not block the form); a hand-typed bill price of more than 2 decimals is therefore accepted too,
  stored rounded to 2 decimals while the line amount keeps the unrounded product. Neither writer is changed here.
- **App list cap:** `/api/accounting/purchase-orders` (the app's list) returns at most 200 rows. With 757 POs the
  page shows the newest 200 per tab. That is a separate, existing limit.
- **Lock hold:** a batch holds the PO counter row until it commits; an in-app PO created meanwhile waits up to 5 s.
