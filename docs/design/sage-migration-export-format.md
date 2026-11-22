# Sage migration: assumed export format and field mapping

Phase D of `docs/design/items-inventory-po-mcp.md`. Code: `src/modules/accounting/services/sage-migration/`, runner
`scripts/sage-migration/run.ts`. **The shapes below are ASSUMED from the Sage Business Cloud Accounting (South Africa,
API v2 "Sage One") documentation; no real export has been seen.** The synthetic fixture
`tests/fixtures/sage-export/sage-export.json` is the executable form of this page. Anything the real export does differently is
a parser change, not a data change: a row the parser cannot read is refused with its reasons, never guessed.

## File

One JSON object with `Items` and/or `PurchaseOrders` and NO other key (a misspelt or re-cased container, `Purchase_Orders`, `items`, is refused by name; a file with neither is refused). `Items` and `PurchaseOrders` each hold the rows as an array, as one Sage list page
(`{"$totalResults", "$startIndex", "$itemsPerPage", "$resources": [...]}`) or as an array of pages.
A page whose `$totalResults` is more than the rows read, or that has a `$next` link, is a partial export and the file is refused. Fields not listed below are ignored. Money is a JSON number.

## Item (`Items`)

| Sage field | Rule | IsaFlow |
|---|---|---|
| `ID` | required, Sage numeric id | `external_ref`, `external_system` `sage` |
| `Code` | required, 1-50 chars, unique in the file | `code` |
| `Description` | required, 1-255 chars | `description` |
| `Active` | required boolean | `is_active` |
| `Physical` | required boolean; false = service | `item_type` `physical` / `service` |
| `PriceExclusive` | optional, >= 0, whole cents (a third decimal is refused) | `sales_price` |
| `PriceInclusive` | ignored | |
| `LastCost`, `AverageCost` | optional, >= 0, rounded to cents | `purchase_price`: LastCost when above 0, else AverageCost |
| `TaxTypeIdSales`, `TaxTypeIdPurchases` | optional; 1 standard, 2 zero, 3 exempt, any other id is refused | `vat_on_sales`, `vat_on_purchases` |
| `Category` | null or `{ID, Description}` | the category (`upsert_item_category`, Sage `ID` as reference), then `category_name` |
| `QuantityOnHand` | **never imported** (Hein): not on the typed row, not on any mapped row, no stock movement written | |
| (always) | | `inventory_tracked` false |

A Sage service code (`Physical` false) with a work-unit counter in `QuantityOnHand` imports as a service; the counter is dropped.

## Purchase order (`PurchaseOrders`)

| Sage field | Rule | IsaFlow |
|---|---|---|
| `ID` | required | `external_ref` (`sage`) |
| `DocumentNumber` | required, unique in the file | `po_number`, `external_document_number` |
| `Date`, `DeliveryDate` | `YYYY-MM-DD` or an ISO date-time; Date required. A date-time with a Z or an offset is converted to the Johannesburg (UTC+2) date: `2026-03-04T22:00:00Z` is 2026-03-05; with no zone it is taken as written | `order_date`, `delivery_date` |
| `Status` | Pending, Overdue, Invoiced, Cancelled (any case) | open, open, billed (= closed), cancelled; any other is refused. How Pending/Overdue go in is the one constant `OPEN_SAGE_PO_IMPORTED_AS` (`sagePoStatus.ts`; `draft` is the alternative) |
| `Currency`, `CurrencyId`, `ExchangeRate` and any field with "currency" or "exchange" in its name | none, or ZAR / rate 1. Anything else is refused as `foreign_currency` (a `CurrencyId` passes only beside a field saying ZAR: its ids are Sage's) | |
| `Reference`, `Comments` | optional | `reference`; `notes` = "Sage status: X" + comments |
| `SupplierId`, `SupplierName` | `SupplierId` required | `supplier_id`: found by Sage reference on the supplier, else by exact name; unresolved or ambiguous refuses the PO |
| `Exclusive`, `Tax`, `Total` | required, whole cents, Exclusive + Tax = Total | `expected_totals` (checked by the tool to the cent) |
| `PdfFile` | optional file name of the PO's PDF | listed in the report; **not uploaded by the runner** |
| `Lines[]` | at least one | `lines` |
| `Lines[].Description`, `Quantity` (> 0, 2 dp), `UnitPriceExclusive` | required | `description`, `quantity`, `unit_price` |
| `Lines[].TaxPercentage` / `TaxTypeId` | one of them; both must agree. The rate is the one that applied on the PO date: standard 14% before 2018-04-01, 15% from then; a percentage is that rate or 0, any other is refused | `tax_rate` |
| `Lines[].Exclusive`, `Tax` | optional, whole cents | `line_total`, `tax_amount` |
| `Lines[].ItemId` (alias `SelectionId`) | optional; must be an item in the file | " [item CODE]" appended to the description |

The PO tool has no `item_id` on a line, so the link to the item is the code in the description until it has one.

## Refusals

A row is refused with a code and every reason: `invalid_row`, `duplicate_id`, `duplicate_code`, `duplicate_number`,
`category_description_conflict`, `category_name_collision`, `unknown_status`, `line_item_unknown`, `supplier_unresolved`,
`supplier_ambiguous` (also when a supplier name search hits its 1000-row cap), `line_item_refused` (a line names an item that is
refused), `code_held_by_existing_item` (an item the migration did not import holds the code, with or without a reference, deleted or not:
the migration only ever updates an item it owns, never one it matched by code), `ref_code_conflict`, `item_deleted`,
`line_description_too_long` (a description with its " [item CODE]" passes 500: nothing is cut), `supplier_ref_conflict` (the
supplier of that name already carries another Sage reference), `foreign_currency`, `po_number_taken` (another PO carries the number), `tool_refuses` (the item or PO tool's own
validator). A refused row is reported and not sent; the rest of the file goes on. A batch a tool refuses as a whole (a budget
block, a race) fails the dry run, so nothing is written; its whole message is in the report file, the console shows its start.

## Running it (local databases only)

```
DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/isaflow_test bun --no-env-file scripts/sage-migration/run.ts \
  --company <uuid> --user <uuid> --file export.json [--live] [--report report.json] [--skip-budget-check] [--po-gl-account <uuid>] [--allow-refusals] [--run-tag <text>] \
  [--expect-items 383] [--expect-pos 757] [--expect-po-total 80950000.00]
```

Without `--live` it is a dry run and writes nothing. With `--live` (which needs `--expect-items` and `--expect-pos`, 0 if none, so a file that lost a container cannot pass unnoticed) it dry-runs first and goes live only if the dry run is clean. A re-run replays finished batches under their keys; if the rows of an earlier run were deleted since, the replayed batch is reported "replayed, rows absent" and fails, and `--run-tag <text>` imports afresh under new keys.
The runner refuses unless `DATABASE_URL` is a local throwaway database (`localGuard.ts`): host 127.0.0.1 or localhost, an
explicit port that is not the IsaFlow Supabase stack's (7770-7776), no query parameters but `sslmode`, and a database named
`isaflow_schema_fixture`, `isaflow_test` or `isaflow_sagemig_*`; `SERVICE_DATABASE_URL`, `PLATFORM_ADMIN_DATABASE_URL` and
`MIGRATION_ADMIN_DATABASE_URL` are held to the same rule when set. `--no-env-file` keeps bun from loading a `.env.local`.
Exit 0 = a clean dry run, or a live run that booked everything it sent; `--expect-*` figures must match what was sent (dry) or
booked (live); and no row refused unless `--allow-refusals`. 1 = anything else; 2 = refused start. The dry run writes categories and
POs inside its rolled-back transaction so each PO batch's budget check sees the batches before it. `--po-gl-account` puts one expense
account on every PO line so the budget check judges the lines (with none a line is "No budget" and never blocked).
`--skip-budget-check` lists the POs the check would have blocked.

## Named limits

- **The snapshot race.** What the company already holds (item codes, PO numbers, supplier references) is read once, before the dry
  run, and the plan refuses rows against it. A writer that adds a clashing row between that read and the live batch can still make a
  tool refuse a batch. The dry run reports such a refusal and writes nothing; a live batch that hits it is reported failed with the
  tool's whole message, nothing of it written, and running again resumes.
- **`--po-gl-account` posts every PO line to that one account.** It is opt-in; the default is no account, and a line with none is
  "No budget" (never blocked). With the flag the budget check, and so what a PO commits, is only as right as that one choice: a line
  that Sage would have coded elsewhere is judged against this account's budget.
