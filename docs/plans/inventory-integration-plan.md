# Inventory integration plan

Status: proposal, 2026-11-06. Base: `origin/master` c4eaf769d. Schema facts are from the migrations and
the committed schema baseline `scripts/ci/integration/baseline.sql.gz` (a schema-only dump of isaflow_dev);
no database was queried for this plan.

## 1. Current state (verified)

### 1.1 Three item models, plus a fourth that never existed

| Model | Defined | Tenant key | Who writes | Who reads |
|---|---|---|---|---|
| `items` + `item_categories` + `item_bundle_lines` | 247:101, 247:134, 303:6 | `company_id NOT NULL`, `UNIQUE(company_id, code)` | `itemService.ts`, `/api/accounting/items` | Inventory nav (`navSections/inventory.ts:12`), `ItemPicker` (`pickerData.ts:78`; no form mounts it), MCP `list_items` |
| `stock_items` | 255:10 (table) | `company_id NOT NULL` | **nothing INSERTs**; `item-adjustments.ts:61` and `item-opening-balances.ts:50` UPDATE rows that cannot exist | item-adjustments, item-opening-balances, item-pricing, and 5 reports (item-listing/-quantities/-valuation/-movement, purchases-by-item) |
| `products` + `product_categories` + `stock_movements` + `stock_adjustments` + `warehouses` + `stock_levels` | 244b | `products.company_id` **nullable**; `product_categories` has **no** `company_id` and `UNIQUE(code)` globally (244b:5-8); `stock_movements` and `stock_levels` have **no** `company_id` (244b:84,101) | `/api/accounting/products`, `/api/accounting/stock-adjustments` (no UI caller, per K-085 validation) | `stock-levels.ts`, `stockValuationService.ts`, MCP `stock_valuation`, AFS `note1PolicyFacts.ts:49` (cost method) |

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
`/purchase-orders` and GRNs) and `supplier_purchase_orders`/`supplier_purchase_order_items` (item_id, no FK;
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

**Design.** `items` becomes the only item master. A new `inventory_movements` table (company-scoped,
dated, signed, costed, linked to its source document line and journal) is the single stock ledger.
`items` carries `qty_on_hand` and `avg_cost` maintained transactionally by one service,
`inventoryPostingService`, which every stock-moving document calls inside its own transaction and which
adds the inventory lines to that document's journal. `products`, `stock_items`, `stock_movements`,
`stock_levels`, `stock_adjustments`, `product_categories` are backfilled into it and then retired.

**Strongest argument against:** `products`/`stock_movements` is the model holding the real data, so
promoting it would move zero rows, whereas this plan rewrites every existing movement's key across tenants.

Why `items` anyway: it is the tenant-safe one (`company_id NOT NULL`, per-company unique code, categories
scoped), it is what the Inventory menu, `ItemPicker`, bundles, sales/purchase orders, delivery notes and
`list_items` already use, and it carries sales/purchase accounts and VAT defaults. `products` would need
its categories re-tenanted, `company_id` made NOT NULL, and every one of those consumers re-pointed.
The backfill is small (`stockValuationService.ts:5-6` notes 6 products / 240 movements on the books it was written
against) and is a one-off.

**Rejected:** (a) promote `products` — see above; (b) keep both and add a `items.product_id` link —
two masters forever, every report needs the join; (c) periodic inventory (no COGS until stocktake) —
simpler but the stock-levels/valuation screens and gross profit stay wrong between counts, which is
the defect being fixed.

### 2.1 Costing: perpetual weighted average

IAS 2.25 and IFRS for SMEs s13.18 allow FIFO or weighted average (LIFO prohibited); SARS accepts either
for s22 if applied consistently. Weighted average is what Sage Business Cloud Accounting/Pastel (the
SA SME incumbents and our migration source) use, needs no cost layers, and is what `products.cost_method`
already defaults to. Rule, per item, in NUMERIC: on receipt
`avg = (qty_on_hand*avg + qty_in*unit_cost) / (qty_on_hand + qty_in)`; every issue leaves at the current
`avg`; `avg_cost NUMERIC(18,6)` (not 15,2 — a 2-dp average drifts), movement `value NUMERIC(15,2)`.
FIFO is not offered; existing `fifo` products are listed by the backfill for Hein.

### 2.2 Data model (migration sketch, next free prefix at time of build; today 962+)

```sql
ALTER TABLE items ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS qty_on_hand NUMERIC(15,4) NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS avg_cost NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN IF NOT EXISTS inventory_account_id UUID REFERENCES gl_accounts(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS cogs_account_id UUID REFERENCES gl_accounts(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS legacy_product_id UUID UNIQUE;   -- backfill map, dropped later

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  item_id UUID NOT NULL REFERENCES items(id),
  movement_date DATE NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('opening','purchase','purchase_return','sale',
    'sale_return','adjustment_in','adjustment_out','write_off','grn','grn_reversal')),
  quantity NUMERIC(15,4) NOT NULL CHECK (quantity <> 0),          -- signed: + in, - out
  unit_cost NUMERIC(18,6) NOT NULL CHECK (unit_cost >= 0),
  value NUMERIC(15,2) NOT NULL,                                   -- signed, = round(quantity*unit_cost,2)
  avg_cost_after NUMERIC(18,6) NOT NULL, qty_after NUMERIC(15,4) NOT NULL,
  source_type TEXT NOT NULL, source_id UUID NOT NULL, source_line_id UUID,
  journal_entry_id UUID REFERENCES gl_journal_entries(id),
  reverses_movement_id UUID REFERENCES inventory_movements(id),
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_inv_mov_company_item_date ON inventory_movements(company_id, item_id, movement_date, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_mov_source_line ON inventory_movements(company_id, source_type, source_line_id, movement_type) WHERE reverses_movement_id IS NULL;

ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES items(id);
ALTER TABLE supplier_invoice_items ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES items(id);
-- credit_notes (customer and supplier, one table) are header-only: amount, no lines. Stock returns need
-- a credit_note_stock_lines(credit_note_id, item_id, quantity) table (P3). NOT VALID FK + VALIDATE pattern for the existing *_item_id columns on
-- delivery_note_lines, customer_sales_order_items, supplier_purchase_order_items; grn_items gets item_id.
```

RLS and grants as for other company tables (app_user: SELECT/INSERT only on `inventory_movements` —
corrections are reversing rows, never UPDATE/DELETE). A tenant-consistency trigger refuses an
`item_id` whose `items.company_id` differs from the row's company. System roles `inventory`,
`cost_of_sales`, `inventory_adjustment` (and `grni` in phase 4) are added to `systemAccountKeys.ts` and
seeded per tenant only where a matching subtype account exists (no account created silently).
Account resolution: item override → system role → refuse to post with a named error.

### 2.3 GL posting rules (all in the source document's own journal; amounts excl VAT)

| Event | Movement | DR | CR |
|---|---|---|---|
| Opening balance | `opening` +q @ cost | Inventory | Opening Balance Equity (`opening_balance_equity`) |
| Supplier bill line, stock item, no GRN | `purchase` +q @ line cost | Inventory (replaces the line's expense account) | AP (existing) |
| Supplier credit note stock line (return) | `purchase_return` −q @ current avg | AP | Inventory; (credit cost − avg)×q to Inventory adjustment |
| Customer invoice line, stock item | `sale` −q @ avg | COGS | Inventory (in addition to AR/Revenue/VAT) |
| Customer credit note stock line ("return to stock") | `sale_return` +q @ cost of the original sale movement | Inventory | COGS |
| Adjustment in / count surplus | `adjustment_in` +q @ entered cost | Inventory | Inventory adjustment |
| Adjustment out / write-off / count shortfall | `adjustment_out`/`write_off` −q @ avg | Inventory adjustment | Inventory |
| GRN (phase 4) | `grn` +q @ PO price | Inventory | GRNI (liability) |
| Bill matched to GRN (phase 4) | none (price variance: stock held → Inventory, else COGS) | GRNI | AP |
| Void / reverse of any of the above | reversing movement + reversing journal (existing reversal path) | mirror | mirror |

Stock moves when the document **posts** (invoice finalised/approved, bill approved), never on draft
save. Delivery notes move no stock and post nothing (the invoice is the single issue point) — see
decision D2. Negative stock: refused at post (decision D1).

## 3. Migration / backfill across tenants

One idempotent script per phase, run per company, report-first (`--dry-run` prints the plan per tenant):
1. Each `products` row with a non-NULL `company_id` → `items` (match on `(company_id, code)`; on match set
   `legacy_product_id`, else insert). `products` with NULL `company_id` and their movements are **not**
   attributed — listed for Hein.
2. Each `stock_movements` row of a mapped product → `inventory_movements`, `movement_date =
   created_at::date` (Africa/Johannesburg), signed by `INBOUND/OUTBOUND_MOVEMENT_TYPES`
   (`stockValuationService.ts:35-50`), `source_type='legacy_stock_movement'`, **no journal**.
   Movements with `total_cost = 0` keep cost 0 and are listed.
3. Replay movements per item in date order to set `qty_on_hand`/`avg_cost`; compare to
   `products.current_stock` and report every difference.
4. GL true-up is NOT automatic: per tenant the script reports subledger value vs the GL balance of
   inventory-subtype accounts. Hein/Willie decide per company whether to post an opening journal.
5. `stock_items` (no writer) is dropped after its readers are re-pointed; `stock_levels` dropped.

verify: per tenant, `count(products with company)` = `count(items.legacy_product_id)`; per item,
Σ`inventory_movements.quantity` = `items.qty_on_hand`; re-run is a no-op (row counts unchanged).

## 4. Phases (each shippable alone)

**P1 — One ledger, correct numbers, no GL (low risk).** Migration (2.2 minus line columns), backfill
script, `inventoryPostingService` (avg-cost maths, `FOR UPDATE` on the item, dated movements), stock
adjustments re-pointed to `items` with a `movementDate` (refused outside an open fiscal period),
stock-levels / item-valuation / item-quantities / item-movement / `stock_valuation` read
`inventory_movements`; item-adjustments and opening balances write it.
verify: unit tests of the average maths (receipt, issue, receipt-after-zero, cents rounding);
integration test: back-dated adjustment lands on its date and as-at valuation honours it; stock-levels
value ≠ 0 after a costed receipt; mutate the avg formula and watch red; MCP `stock_valuation` and the
UI page agree on one fixture company.
Risk: backfill mismatches on live tenants → mitigated by dry-run report before any write.

**P2 — GL posting for adjustments and opening balances.** System roles + per-tenant seeding,
journals for opening/adjustment/write-off/count in the same tx as the movement.
verify: integration test asserts each movement's `value` equals its journal's inventory line and the
journal balances; subledger = GL check added to `data_integrity_checks`. Risk: tenants without an
inventory account — post is refused with a named error, never defaulted.

**P3 — Invoices and bills.** `item_id` on invoice/bill lines, `credit_note_stock_lines`, `ItemPicker` in those forms,
post-time movements + COGS/Inventory lines in the document journal, reversal on void/credit.
verify: golden path "buy 10 @ R100, sell 4 @ R150" → stock 6, value R600, COGS R400, GP R200 on the
P&L; void the sale → stock 10, COGS 0; concurrent sales of the last unit: one succeeds, one refused.
Risk: HIGH — touches AR/AP posting paths; adversarial ledger review required; changes the approval
digest of item lines (check `approval_document_digest`).

**P4 — GRN/GRNI and PO consolidation.** GRN moves stock against GRNI; bill clears GRNI; pick one PO
model (`supplier_purchase_orders`, item-based) and retire `purchase_orders`/`po_items` with a backfill.
verify: GRN then bill leaves GRNI at 0 and inventory at bill cost; price variance test both branches.
Risk: MEDIUM — three-way-match and budgets commitment read `po_items`.

**P5 — Retire legacy.** Drop `stock_items`, `stock_levels`, re-point AFS note 1 to `items`, then (after
a release on the new model) drop `products`/`stock_movements`/`stock_adjustments`/`product_categories`
and the `/products` pages. verify: grep census shows no reader of the dropped tables; CI green.

## 5. Open decisions for Hein

- **D1 Negative stock:** refuse at post (recommended; keeps the average meaningful) or allow with a warning.
- **D2 Issue point:** invoice (recommended) or delivery note when one exists before the invoice.
- **D3 Back-dating:** allow within an open period and re-cost that item's later movements (recommended),
  or refuse a date earlier than the item's latest movement.
- **D4 GL true-up per tenant** after backfill: post an opening inventory journal, or leave GL as-is and
  start the subledger at zero value.
- **D5 FIFO:** drop it (recommended) or keep as a later phase.
- **D6 Orphans:** `products` / movements with NULL `company_id` — delete, or assign by hand.
