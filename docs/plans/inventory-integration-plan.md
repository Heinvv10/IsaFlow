# Inventory integration plan

Status: proposal, 2026-11-06. Base: `origin/master` c4eaf769d, re-checked on e37f19d42. Schema facts are from the migrations and
the committed schema baseline `scripts/ci/integration/baseline.sql.gz` (a schema-only dump of isaflow_dev);
no database was queried for this plan.

## 1. Current state (verified)

### 1.1 Three item models, plus a fourth that never existed

| Model | Defined | Tenant key | Who writes | Who reads |
|---|---|---|---|---|
| `items` + `item_categories` + `item_bundle_lines` | 247:101, 247:134, 303:6 | `company_id NOT NULL`, `UNIQUE(company_id, code)` | `itemService.ts`, `/api/accounting/items` | Inventory nav (`navSections/inventory.ts:12`), `ItemPicker` (`pickerData.ts:78`; no form mounts it), MCP `list_items` |
| `stock_items` | 255:10 (table) | `company_id NOT NULL` | **nothing INSERTs**; `item-adjustments.ts:61` and `item-opening-balances.ts:50` UPDATE rows that cannot exist | item-adjustments, item-opening-balances, item-pricing, and 5 reports (item-listing/-quantities/-valuation/-movement, purchases-by-item) |
| `products` + `product_categories` + `stock_movements` + `stock_adjustments` + `warehouses` + `stock_levels` | 244b | `products.company_id` **nullable**; `product_categories.company_id` is **nullable** (added by 292b; the 8 seed rows stay NULL, shared) and `UNIQUE(code)` is still global (244b:5-8), so two tenants cannot both have code `RAW`; `stock_movements` and `stock_levels` have **no** `company_id` (244b:84,101) | `/api/accounting/products`, `/api/accounting/stock-adjustments` (no UI caller, per K-085 validation) | `stock-levels.ts`, `stockValuationService.ts`, MCP `stock_valuation`, AFS `note1PolicyFacts.ts:49` (cost method) |

Correction to the brief: `stock_items` is **not** a view. Migration 253:137 declares
`CREATE OR REPLACE VIEW stock_items` over `products.sku` / `products.qty_on_hand`, columns `products`
never had (244b:20-58), so that view cannot have been created; 255:10 created a real, separate table,
and the baseline holds that table. It has no writer, so every screen on it is empty by construction.
`item-movement.ts:34` and `purchases-by-item.ts:31` additionally join `stock_items.id` to
`grn_items.product_id` / `po_items.product_id`, which are FKs to `products` — ids from a different table,
so those two reports cannot return a row even if `stock_items` had data.

`stock_levels` has no reader or writer anywhere in `src/` or `pages/`. The default warehouse is seeded
with a NULL `company_id` (244b, tail INSERT).

Two purchase-order models also exist: `purchase_orders`/`po_items` (product_id → products; used by
`/purchase-orders`, GRNs, and since budgets P5-3 (#1114) commitments, line CC1/CC2/BU, approve/cancel,
bill `po_item_id` links and three-way match — `services/ap/.claude.md` L7, L38, L64; `po_items` has no
`company_id`, tenancy is through `purchase_orders`) and `supplier_purchase_orders`/`supplier_purchase_order_items` (item_id, no FK;
used by `/supplier-purchase-orders`, `purchaseOrderService.ts:77`).

### 1.2 Document lines carry no item reference — claim CONFIRMED

`customer_invoice_items` and `supplier_invoice_items` have no `item_id`/`product_id` (baseline; no later
`ALTER` adds one — 299, 375, 413, 870, 874, 956 add currency, time entry, match, dimension and position
columns only). Inserts: `customerInvoiceCreateService.ts:208`, `quoteConvertService.ts:230`,
`supplierInvoiceService.ts:155`, `captureBillLines.ts:169`. `supplier_invoice_items.po_item_id` exists
(no FK) and links to `po_items` (`supplierInvoicePoLinks.ts:38`), so a bill line reaches a product only
via a PO. `ItemPicker` exists but no form uses it. Sales-by-item groups by description/GL account
(`sales-by-item.ts:33`), not by item.

Lines that DO carry an item: `customer_sales_order_items.item_id` (247:41), `supplier_purchase_order_items.item_id`
(247:88), `delivery_note_lines.item_id` (302:28) — all pointing at `items`, none with an FK.

### 1.3 No GL posting from inventory — claim CONFIRMED

- `stock-adjustments.ts` writes `stock_adjustments`, `products.current_stock` and `stock_movements`;
  `stock_adjustments.journal_entry_id` (244b) is never set. No journal.
- `systemAccountKeys.ts:36-50` has no `inventory`, `cost_of_sales` or GRNI role;
  `defaultAccountRoles.ts:19` maps `cost_of_sales` to `default_expense`.
- `products.gl_inventory_account_id` / `gl_cogs_account_id` have no reader outside the NL-query FK list.
- No AR/AP posting service references `stock_movements`, `current_stock` or a COGS account.
- `items/adjustmentService.ts` posts a journal, but it is customer/supplier **balance** adjustments
  (`accounting_adjustments`, receivable/payable vs other_income/admin_expense, lines 140-148), not stock.
  The comments in 605:117 and 607:51 calling it a "positive stock adjustment" are wrong.

### 1.4 Stock adjustments always dated today — claim CONFIRMED (and wider)

`StockAdjustmentInput` has no date (`inventoryService.ts:26-33`); the INSERT omits `adjustment_date`
(`stock-adjustments.ts:79`), so it takes `DEFAULT CURRENT_DATE` (244b). `stock_movements` has **no date
column at all** — only `created_at DEFAULT NOW()` — and `stockValuationService` values "as at" by
`sm.created_at` (line 138). A back-dated receipt is therefore impossible in the model, not just the API.
GRN (`received_date`) and delivery notes (`delivery_date`) do take a date, but move no stock.

### 1.5 Stock-levels value R0 — claim CONFIRMED, cause is wider than receipts

`products.avg_cost` has **no writer anywhere**: not the adjustment API, not product create
(`products.ts:75` sets `cost_price` only), not a receipt (there is no receipt path).
`stock-levels.ts:20` computes `current_stock * avg_cost`, so it is always 0. `products/index.tsx:44`
falls back to `cost_price`, so the two screens disagree. `calculateWeightedAverage` /
`calculateFIFO` (`inventoryService.ts:57,75`) have no caller outside tests.

### 1.6 GRNs, delivery notes, POs

- **GRN** (`goodsReceivedService.ts:36-55`): inserts `goods_received_notes` + `grn_items` (without
  `product_id`, line 42), bumps `po_items.quantity_received`. No stock movement, no journal.
- **Delivery note** (`deliveryNoteService.ts`): stores `item_id` on lines (224); status changes
  (251, 266) move no stock and post nothing. `invoice_id` is a free UUID.
- **PO**: commitments only (budgets), correctly no GL.

### 1.7 MCP

- `list_items` reads `items` via `itemService.listItems` (`inventoryAndAp.ts:51`).
- `stock_valuation` reads `products` ⨝ `stock_movements` via `stockValuationService` and values at the
  cost on each movement (`inventoryAndAp.ts:112-117`). Both tool descriptions already disclose the split.

## 2. Recommendation: one item master (`items`), one dated movement ledger, perpetual weighted average posted to GL

**Design.** `items` is the only item master. A new append-only `inventory_movements` table (company-scoped,
dated, signed, costed, linked to its source line and journal) is the single stock ledger. `items.current_qty`
(kept under its existing name; no rename, no second qty field) and a new `avg_cost` are maintained by one service, `inventoryPostingService`,
called inside each stock-moving document's transaction, adding inventory lines to that document's journal.
The `products` family and `stock_items`/`stock_levels` are backfilled into it and retired.

**Strongest argument against:** `products`/`stock_movements` is the model holding the real data, so
promoting it would move zero rows, whereas this plan rewrites every existing movement's key across tenants.

Why `items` anyway: it is tenant-safe (`company_id NOT NULL`, per-company unique code, scoped categories),
the Inventory menu, `ItemPicker`, bundles, sales/purchase orders, delivery notes and `list_items` already
use it, and it carries sales/purchase accounts and VAT defaults. `products` would need `company_id` NOT
NULL, a per-company category key in place of the global `UNIQUE(code)`, the NULL-company seed categories
split per tenant, and all those consumers re-pointed. The backfill is small (6 products / 240 movements,
`stockValuationService.ts:5-6`) and one-off.

**Rejected:** (a) promote `products` (above); (b) keep both, linked — two masters forever; (c) periodic
inventory — gross profit and valuation stay wrong between counts, which is the defect being fixed.

### 2.1 Costing: perpetual weighted average

IAS 2.25 and IFRS for SMEs s13.18 allow FIFO or weighted average (not LIFO); SARS accepts either for s22
if consistent. Weighted average is what Sage/Pastel (our migration source) use, needs no cost layers, and
is `products.cost_method`'s default. FIFO is not offered; `fifo` products are listed by the backfill (D5).

Rules, per item, in NUMERIC (`avg_cost NUMERIC(18,6)`; a 2-dp average drifts):
- Receipt: `avg = (qty*avg + qty_in*unit_cost) / (qty + qty_in)`. Issue: leaves at the current `avg`,
  `value = round(-qty_out*avg, 2)`.
- **Zero-out:** an issue that takes `current_qty` to 0 takes the item's whole remaining value (−Σ`value`),
  not `qty*avg`, so rounding cents never strand on an empty item.
- **Negative stock** (D1): refused when `current_qty - qty_out < 0`. Since nothing is dated before the
  item's latest movement (2.4), the current balance is the balance on that date; no later row can go negative.
- **Locking:** one `SELECT … FROM items WHERE company_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE` per
  document, before any movement, so multi-line documents lock items in one order and cannot deadlock
  (census it against the AR/AP posting lock order first).

**Receipt cost** (bill line, `purchase`) = the line amount excl VAT, net of any line discount (bill lines
have none today), converted to ZAR at the bill's `exchange_rate` (the figure the AP journal posts), ÷ qty.
Input VAT that cannot be claimed (non-vendor supplier, or a line whose input VAT is denied) is added to
cost. A DRC bill's self-assessed VAT nets off and is excluded from cost.

**Precision:** movement `quantity` and `items.current_qty` are `NUMERIC(15,4)`; bill lines (`12,4`) and
invoice lines (`customer_invoice_items.quantity numeric(10,2)`) both fit, so neither is widened; a
stock item therefore sells in 2-dp quantities. `value NUMERIC(15,2)`.

### 2.2 Data model (migration sketch; next free prefix at build time, 963 today)

```sql
ALTER TABLE items ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT false;
-- no RENAME: deploy.sh migrates prod before the idle colour is switched in, so the live colour still reads
-- current_qty (itemService.ts:225,263; items/index.tsx:237; [itemId].tsx:137) and rollback is code-only.
-- Expand/contract: keep current_qty as the one qty field; any rename waits for P5, after no reader remains.
ALTER TABLE items ALTER COLUMN current_qty TYPE NUMERIC(15,4);           -- then NOT NULL after NULL → 0
ALTER TABLE items ADD COLUMN IF NOT EXISTS avg_cost NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS inventory_account_id UUID REFERENCES gl_accounts(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS cogs_account_id UUID REFERENCES gl_accounts(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS legacy_product_id UUID UNIQUE;   -- backfill map, dropped later

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  item_id UUID NOT NULL REFERENCES items(id),
  warehouse_id UUID REFERENCES warehouses(id),                    -- carried, not costed (D7)
  -- tenant trigger: warehouse must have company_id = this row's company_id; the NULL-company default
  -- warehouse (244b seed) is refused — backfill maps it to a per-company default warehouse it creates.
  movement_date DATE NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('opening','purchase','purchase_return','sale',
    'sale_return','adjustment_in','adjustment_out','write_off','count_adjustment','transfer_in',
    'transfer_out','grn','grn_reversal')),
  quantity NUMERIC(15,4) NOT NULL CHECK (quantity <> 0),          -- signed: + in, - out
  unit_cost NUMERIC(18,6) NOT NULL CHECK (unit_cost >= 0),
  value NUMERIC(15,2) NOT NULL,                                   -- signed; = round(quantity*unit_cost,2) except zero-out
  avg_cost_after NUMERIC(18,6) NOT NULL, qty_after NUMERIC(15,4) NOT NULL,
  source_type TEXT NOT NULL, source_id UUID NOT NULL, source_line_id UUID,
  journal_entry_id UUID REFERENCES gl_journal_entries(id),
  reverses_movement_id UUID UNIQUE REFERENCES inventory_movements(id),
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_inv_mov_company_item_date ON inventory_movements(company_id, item_id, movement_date, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_source ON inventory_movements
  (company_id, source_type, source_id, source_line_id, item_id, movement_type) NULLS NOT DISTINCT
  WHERE reverses_movement_id IS NULL;   -- header-only sources (adjustment, opening) have NULL line id

-- P3: item_id → items on customer_invoice_items and supplier_invoice_items. credit_notes are header-only,
-- so returns get credit_note_stock_lines(id, company_id, credit_note_id, item_id, quantity,
-- source_line_id NOT NULL) -- the original invoice/bill line: sale_return takes that line's sale cost
-- and a return cannot exceed what it moved. P4: item_id on po_items and grn_items. NOT VALID FK +
-- VALIDATE for the existing item_id on delivery_note_lines and customer_sales_order_items.
```

`NULLS NOT DISTINCT` (PG15+, precedent 680) makes header-only sources idempotent; `item_id` is in the key
because a bundle line explodes into several component movements.

RLS and grants as for other company tables (app_user: SELECT/INSERT only on `inventory_movements` —
corrections are reversing rows, never UPDATE/DELETE). A tenant-consistency trigger refuses an
`item_id` whose `items.company_id` differs from the row's company. Only `inventoryPostingService` writes
`current_qty`/`avg_cost`: the `current_qty` write via `/api/accounting/items` (`items.ts:156`,
`itemService.ts:263`) is removed; its readers (items list/detail pages, `itemService` SELECT) keep reading `current_qty`.
System roles `inventory`, `cost_of_sales`, `inventory_adjustment` (`grni` in P4) go in
`systemAccountKeys.ts`, seeded per tenant only where a matching subtype account exists. Account
resolution: item override → system role → refuse to post with a named error.

### 2.3 GL posting rules (all in the source document's own journal; amounts excl VAT)

| Event | Movement | DR | CR |
|---|---|---|---|
| Opening balance | `opening` +q @ cost | Inventory | Opening Balance Equity (`opening_balance_equity`) |
| Supplier bill line, stock item, no GRN | `purchase` +q @ receipt cost (2.1) | Inventory (replaces the line's expense account) | AP (existing) |
| Supplier credit note stock line (return) | `purchase_return` −q @ current avg | AP | Inventory; (credit cost − avg)×q to Inventory adjustment |
| Customer invoice line, stock item | `sale` −q @ avg | COGS | Inventory (in addition to AR/Revenue/VAT) |
| Customer credit note stock line ("return to stock") | `sale_return` +q @ unit cost of the original line's `sale` movement | Inventory | COGS |
| Adjustment in / count surplus | `adjustment_in`/`count_adjustment` +q @ entered cost (count: current avg) | Inventory | Inventory adjustment |
| Adjustment out / write-off / count shortfall | `adjustment_out`/`write_off`/`count_adjustment` −q @ avg | Inventory adjustment | Inventory |
| GRN (P4) | `grn` +q @ PO price | Inventory | GRNI (liability) |
| Bill matched to GRN (P4) | none (price variance: stock held → Inventory, else COGS) | GRNI | AP |
| Void / reverse of any of the above | reversing movement dated today + reversing journal (existing reversal path) | mirror | mirror |

Stock moves when the document **posts** (invoice finalised, bill approved), never on draft save. Delivery
notes move nothing (D2). A stocktake writes the delta (counted − on hand) as one `count_adjustment`.

**Bundles** (`is_bundle`, `item_bundle_lines`): a bundle never carries stock (`track_stock` stays false).
At post, a bundle line explodes to one movement per stock-tracked component (`quantity × component
qty`), all sharing the line's `source_line_id`; COGS is Σ component values. Revenue stays on the bundle
line. In scope for P3; until then a bundle on an invoice moves nothing.

### 2.4 Dating: append-only ledger, no back-dating past the item's last movement

A movement may not be dated before the latest `movement_date` of **its item** (other items are free), and
must fall in an open fiscal period. Corrections are new movements dated today (reversal plus a fresh row),
never edits; same-date rows order by `created_at`. Every stored `*_after` and posted COGS line is then
final, as the SELECT/INSERT-only grant and locked periods require.

**Rejected: re-cost later movements on a back-dated insert.** A receipt dated before existing sales
changes the average those sales left at, so it would need UPDATE on movement rows (forbidden above) and
correcting COGS journals for every later sale — including ones in closed or VAT-locked periods, which
cannot be posted to.

## 3. Migration / backfill across tenants

Schema is a migration; the **data** backfill is a per-tenant TypeScript script (pattern of
`scripts/backfill-auto-postings.ts`), not a migration: `items`/`products` are FORCE RLS and production
migrations run as the non-superuser `postgres`, so a SQL backfill would see no tenant rows. One
transaction per company with the GUCs `withAuth` sets, so RLS and the tenant trigger apply; `--dry-run`
rolls back and prints the plan (rehearse on `isaflow_staging`, `assertBackfillDryRunDb.ts`). The parity
gate compares migrations only; the schema-only migration replays on an empty integration database.

1. Each `products` row with a non-NULL `company_id` → `items` (match `(company_id, code)`: set
   `legacy_product_id`, else insert). NULL-company products and their movements are listed for Hein (D6).
   `track_stock = true` for items from a product with movements or stock, and for `items` with non-zero
   `opening_qty`/`current_qty`; else false. Categories map to per-company `item_categories` (NULL-company
   seed categories copied into each tenant that uses one).
2. Non-zero `items.opening_qty/opening_cost` → one `opening` movement (`opening_date`, else the
   company's first open period start).
3. Each `stock_movements` row of a mapped product → `inventory_movements`, `movement_date =
   created_at::date` (Africa/Johannesburg), `source_type='legacy_stock_movement'`, `source_id` = its id,
   **no journal**, `warehouse_id` carried (a movement on the NULL-company 244b default warehouse maps to a per-company "Default" warehouse the script creates first). Type mapping: `purchase`/`sale`/`adjustment_in`/
   `adjustment_out`/`write_off`/`grn`/`transfer_in`/`transfer_out` keep their name; `return_in` →
   `sale_return`; `return_out` → `purchase_return`; `count` (an **absolute** observed quantity) →
   `count_adjustment` with quantity = count − running quantity at that point of the replay (skipped
   when 0), so the running total equals the count afterwards. Movements with `total_cost = 0` keep
   cost 0 and are listed.
4. Replay movements per item in (date, created_at) order to set `current_qty`/`avg_cost`/`*_after`;
   compare to `products.current_stock` and report every difference. Replay ignores D1, but every point
   where the running quantity goes negative is reported.
5. GL true-up is NOT automatic: per tenant the script reports subledger value vs the GL balance of
   inventory-subtype accounts. Hein/Willie decide per company whether to post an opening journal (D4).
6. `stock_items` (no writer) is dropped after its readers are re-pointed; `stock_levels` dropped.

verify: per tenant, `count(products with company)` = `count(items.legacy_product_id)`; per item,
Σ`quantity` = `items.current_qty`; a re-run is a no-op (row counts unchanged).

## 4. Phases (each shippable alone)

**P1 — One ledger, correct numbers, no GL (low risk).** Migration (2.2 minus line columns), backfill
script, `inventoryPostingService` (avg-cost maths, ordered `FOR UPDATE`, dated movements, 2.4 date rule),
stock adjustments and counts re-pointed to `items` with a `movementDate`, stock-levels / item-valuation /
item-quantities / item-movement / `stock_valuation` read `inventory_movements`; item-adjustments and
opening balances write it.
verify: unit tests of the average maths (receipt, issue, receipt-after-zero, zero-out leaves value 0,
cents rounding); integration tests: an adjustment dated before the item's last movement is refused, one
dated on/after it lands on its date and as-at valuation honours it; stock-levels value ≠ 0 after a
costed receipt; two documents locking the same two items in opposite line order both complete; mutate
the avg formula and watch red; MCP `stock_valuation` and the UI page agree on one fixture company.
Risk: backfill mismatches on live tenants → mitigated by dry-run report before any write.

**P2 — GL posting for adjustments and opening balances.** System roles + per-tenant seeding,
journals for opening/adjustment/write-off/count in the same tx as the movement.
verify: integration test asserts each movement's `value` equals its journal's inventory line and the
journal balances; subledger = GL check added to `data_integrity_checks`. Risk: tenants without an
inventory account — post is refused with a named error, never defaulted.

**P3 — Invoices and bills.** `item_id` on invoice/bill lines, `credit_note_stock_lines`, `ItemPicker` in
those forms, bundle explosion, post-time movements + COGS/Inventory lines in the document journal,
reversal on void/credit.
verify: golden path "buy 10 @ R100, sell 4 @ R150" → stock 6, value R600, COGS R400, GP R200 on the
P&L; void the sale → stock 10, COGS 0; concurrent sales of the last unit: one succeeds, one refused;
FX bill (on a test company with `companies.fx_documents_enabled` set by a platform admin; foreign bills are refused while it is off, ap/.claude.md), VAT-denied line and DRC bill each land at the cost in 2.1; credit note beyond the original line's
quantity refused.
Risk: HIGH — touches AR/AP posting paths; adversarial ledger review required; changes the approval
digest of item lines (check `approval_document_digest`).

**P4 — GRN/GRNI and PO consolidation.** GRN moves stock against GRNI; bill clears GRNI. Keep
`purchase_orders`/`po_items` (budgets P5-3 commitments, line dimensions, approve/cancel, bill links and
three-way match are built on it); add `po_items.item_id` (→ `items`, mapped from `product_id` via
`legacy_product_id`). Retire `supplier_purchase_orders`/`_items` by backfilling into the flat family and
re-pointing `purchaseOrderService` and `/supplier-purchase-orders`. `po_items` gets no `company_id`: new
queries reach tenancy through `purchase_orders`, as `threeWayMatchState.ts` does.
verify: GRN then bill leaves GRNI at 0 and inventory at bill cost; price variance test both branches;
the budgets P5 integration suites (`tests/integration/budgets-p5-po-*.int.test.ts`) stay green; a
backfilled supplier PO shows the same totals and open commitment as before.
Risk: HIGH — rewires a live AP path and the budgets commitment it feeds; adversarial ledger review.

**P5 — Retire legacy.** Drop `stock_items`, `stock_levels`, re-point AFS note 1 to `items`, then (after
a release on the new model) drop `products`/`stock_movements`/`stock_adjustments`/`product_categories`,
`supplier_purchase_orders`/`_items` and the `/products` pages. verify: grep census shows no reader of the
dropped tables; CI green.

## 5. Open decisions for Hein

- **D1 Negative stock:** refuse at post (recommended; keeps the average meaningful) or allow with a warning.
- **D2 Issue point:** invoice (recommended) or delivery note when one exists before the invoice.
- **D3 Back-dating:** refuse a movement dated before the item's latest movement; corrections are new
  movements dated today (recommended, 2.4), or re-cost later movements (rejected in 2.4: needs UPDATE on
  the ledger and correcting journals in closed periods).
- **D4 GL true-up per tenant** after backfill: post an opening inventory journal, or leave GL as-is and
  start the subledger at zero value.
- **D5 FIFO:** drop it (recommended) or keep as a later phase.
- **D6 Orphans:** `products` / movements with NULL `company_id` — delete, or assign by hand.
- **D7 Warehouses:** one company-wide quantity and average per item (recommended; `warehouse_id` is carried
  so per-warehouse quantity stays derivable, but nothing is costed, limited or reported per warehouse),
  or per-warehouse stock as a later phase. Nothing reads `stock_levels` today.
