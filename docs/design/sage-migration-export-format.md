# Sage migration: assumed export format and field mapping

Phase D of `docs/design/items-inventory-po-mcp.md`. Code: `src/modules/accounting/services/sage-migration/`, runner
`scripts/sage-migration/run.ts`. **The shapes below are ASSUMED from the Sage Business Cloud Accounting (South Africa,
API v2 "Sage One") documentation; no real export has been seen.** The synthetic fixture
`tests/fixtures/sage-export/sage-export.json` is the executable form of this page. Anything the real export does differently is
a parser change, not a data change: a row the parser cannot read is refused with its reasons, never guessed.

## File

One JSON object. `Items` and `PurchaseOrders` each hold the rows as an array, as one Sage list page
(`{"$totalResults", "$startIndex", "$itemsPerPage", "$resources": [...]}`) or as an array of pages.
Fields not listed below are ignored. Money is a JSON number.

## Item (`Items`)

| Sage field | Rule | IsaFlow |
|---|---|---|
| `ID` | required, Sage numeric id | `external_ref`, `external_system` `sage` |
| `Code` | required, 1-50 chars, unique in the file | `code` |
| `Description` | required, 1-255 chars | `description` |
| `Active` | required boolean | `is_active` |
| `Physical` | required boolean; false = service | `item_type` `physical` / `service` |
| `PriceExclusive` | optional, >= 0 | `sales_price` |
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
| `Date`, `DeliveryDate` | `YYYY-MM-DD` or an ISO date-time; Date required | `order_date`, `delivery_date` |
| `Status` | Pending, Overdue, Invoiced, Cancelled (any case) | open, open, billed (= closed), cancelled; any other is refused |
| `Reference`, `Comments` | optional | `reference`; `notes` = "Sage status: X" + comments |
| `SupplierId`, `SupplierName` | `SupplierId` required | `supplier_id`: found by Sage reference on the supplier, else by exact name; unresolved or ambiguous refuses the PO |
| `Exclusive`, `Tax`, `Total` | required, whole cents, Exclusive + Tax = Total | `expected_totals` (checked by the tool to the cent) |
| `PdfFile` | optional file name of the PO's PDF | listed in the report; **not uploaded by the runner** |
| `Lines[]` | at least one | `lines` |
| `Lines[].Description`, `Quantity` (> 0, 2 dp), `UnitPriceExclusive` | required | `description`, `quantity`, `unit_price` |
| `Lines[].TaxPercentage` / `TaxTypeId` | one of them; both must agree | `tax_rate` |
| `Lines[].Exclusive`, `Tax` | optional, whole cents | `line_total`, `tax_amount` |
| `Lines[].ItemId` (alias `SelectionId`) | optional; must be an item in the file | " [item CODE]" appended to the description |

The PO tool has no `item_id` on a line, so the link to the item is the code in the description until it has one.

## Refusals

A row is refused with a code and every reason: `invalid_row`, `duplicate_id`, `duplicate_code`, `duplicate_number`,
`category_description_conflict`, `category_name_collision`, `unknown_status`, `line_item_unknown`, `supplier_unresolved`,
`supplier_ambiguous`, `tool_refuses` (the item or PO tool's own validator). A refused row is reported and not sent; the rest of
the file goes on. A batch the tool refuses as a whole (a number already taken, a budget block) is reported with the tool's
message, and its rows are not written.

## Running it (local databases only)

```
DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/isaflow_test bun --no-env-file scripts/sage-migration/run.ts \
  --company <uuid> --user <uuid> --file export.json [--live] [--report report.json] [--skip-budget-check] \
  [--expect-items 383] [--expect-pos 757] [--expect-po-total 80950000.00]
```

Without `--live` it is a dry run and writes nothing. With `--live` it dry-runs first and goes live only if the dry run is clean.
The runner refuses unless `DATABASE_URL` is a local throwaway database (`localGuard.ts`): host 127.0.0.1 or localhost, an
explicit port that is not the IsaFlow Supabase stack's (7770-7776), no query parameters but `sslmode`, and a database named
`isaflow_schema_fixture`, `isaflow_test` or `isaflow_sagemig_*`; `SERVICE_DATABASE_URL`, `PLATFORM_ADMIN_DATABASE_URL` and
`MIGRATION_ADMIN_DATABASE_URL` are held to the same rule when set. `--no-env-file` keeps bun from loading a `.env.local`.
Exit 0 = clean dry run, or a complete live run whose `--expect-*` figures match; 1 = anything else; 2 = refused start.
