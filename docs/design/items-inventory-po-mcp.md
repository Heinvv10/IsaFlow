# Items, Inventory & Purchase Orders — MCP design note

Status: Phase A in build (2026-11-18). Brief: Hein, 2026-11-18. It replaces `brief-isaflow-po-migration-mcp-20261118`.

## Why

IsaFlow has three stock models and two PO models, and no MCP write tool for any of them. Velocity Fibre's Sage data
(383 items, 757 POs PO0000197–953 worth R80.95m, with a PDF for each) cannot be migrated until there is one model and tools
that are idempotent on `external_ref`.

## Canonical model (decided)

| Concern | Canonical | Retired / legacy |
|---|---|---|
| Item catalogue | `items` (+ `item_categories`) | `products`, `product_categories`, `stock_items`: no new writes. Velocity has 0 `products` rows on prod (18 Nov). |
| Stock | `stock_movements` rows against `items.id` (`item_id`), with their own `company_id` | `stock_levels`: a cache only, never the source of truth. `product_id` stays for legacy rows. |
| Locations | `warehouses` (+ `location_type`: warehouse / site / vehicle) | 5 seeded rows with `company_id IS NULL` are not tenant data and are never returned. |
| Purchase orders | `purchase_orders` + `po_items`: bills already link through `supplier_invoice_items.po_item_id`, budget "committed" reads them, and they carry cc1/cc2/bu | `supplier_purchase_orders`: **retired in Phase B** (Hein, 18 Nov). Its rows migrate into `purchase_orders` and its UI points at the canonical table. |

The tenant gap: `stock_movements` and `stock_levels` have no `company_id` and no RLS. Phase A adds `company_id`, backfills
it from `products.company_id`, adds a BEFORE INSERT trigger (SECURITY INVOKER) that fills a missing `company_id` from the row's
product, and gives both tables the same RLS policies as `items`. Tenant scope is therefore trigger + RLS; there is no NOT NULL
CHECK (a movement of a product with no company stays NULL, and only a superuser or owner can write one: master's valuation
tests do). A row's `item_id` must belong to its company: a composite FK on `stock_movements`, a trigger on the four line tables.
`po_items` gets the same treatment in Phase B.

## Phase A — item master

Columns added to `items`: `external_system`, `external_ref`, `external_document_number` (unique per company on
system + ref when present, because an item is a catalogue entry, not a document), `inventory_tracked` (default false),
`purchase_price` (= `cost_price`, kept), `sales_price` (= `selling_price_excl`, kept). The existing columns are reused:
tax types = `vat_on_sales` / `vat_on_purchases`, default GL = `sales_account_id` / `purchases_account_id`, type =
`item_type` (physical | service), `is_active`. A Sage "service" code with a work-unit counter imports as `service` with
`inventory_tracked = false`, so it never becomes stock.

Tools: `list_items` (rewrite: cursor, filters, external ref), `get_item`, `bulk_upsert_items` (≤500 rows, match on
external ref first and then on code; a row whose ref and code hit two different items is refused), `update_item`,
`deactivate_item`, `list_item_categories`, `upsert_item_category`, and `find_by_external_ref` kind `item` (Sage code `item`).
New scopes: `read:items`, `write:items`.

Document lines: `item_id` is added to `po_items`, `supplier_invoice_items`, `customer_invoice_items` and `customer_quote_lines`.
A line with an `item_id` and no `gl_account_id` takes the item's purchase account (POs, bills) or sales account (invoices,
quotes). An inactive item or one from another company is refused. Dimensions work as they do today.

Every write tool takes: the `company_id` guard, `idempotency_key`, `dry_run` (the same guards as the live path, and it does
not consume the key), an audit row, all-or-nothing batches, and a refusal reason per row.

## Phase B — purchase orders

Phase B builds on draft PR #1591 (`feat/mcp-purchase-orders-20261118`, the narrower PO-migration brief): its migration 1001 already adds `external_ref` to `purchase_orders`, the `closed` status and `purchase_order` upload targets, and its `bulk_create_purchase_orders` and `list_purchase_orders` tools. Phase B adds the rest.

Statuses: `draft | approved (MCP "open") | partially_received | received | billed | closed | cancelled`. The existing
`submitted` status stays for the UI. Sage mapping: Pending/Overdue → open, **Invoiced → closed** (the imported POs have no
linked IsaFlow bills; `billed` is kept for the status a linked bill sets), Cancelled → cancelled. An explicit
`po_number` is honoured exactly and a duplicate is refused. After an import, the `purchase_order` counter moves to max + 1.
Nothing posts to the GL. Committed = open PO lines less billed (`budgets/remainingCommitted.ts` already does this; it
gains no statuses, so billed, closed and cancelled POs commit nothing). Attachments: `entity_type = purchase_order`.

## Phase C — inventory (company setting `inventory_mode`, default `expense`)

`expense`: quantity only, no stock journal (today's behaviour). `perpetual`: a receipt posts DR Inventory and CR the
GRNI/AP side, and an issue posts DR COS or project (cc2/bu) and CR Inventory. Costing is weighted average per item and
company, recomputed on each inbound movement; an issue is costed at the average on hand at its timestamp. Stocktake
converts an absolute count to a delta movement. `reconcile_inventory` compares the subledger value with the GL inventory
account; the expected difference is 0.00. Open before Phase C (to be grilled then): the inventory and GRNI accounts, and
how a receipt and a bill on the same PO line avoid a double debit.

## Phase D — Sage migration

Re-runs are idempotent through `external_ref`. `import_opening_stock` is a separate tool: perpetual mode only, it refuses
in expense mode, and it has a dry run. Sage quantities on hand are never imported as opening stock by the item or PO tools.
