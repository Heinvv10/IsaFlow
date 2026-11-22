# Sage migration: assumed export format and field mapping

Phase D of `docs/design/items-inventory-po-mcp.md`. Code: `src/modules/accounting/services/sage-migration/`, runner
`scripts/sage-migration/run.ts`. **The shapes below are ASSUMED from the Sage Business Cloud Accounting (South Africa,
API v2 "Sage One") documentation; no real export has been seen.** The synthetic fixture
`tests/fixtures/sage-export/sage-export.json` is the executable form of this page. Anything the real export does differently is
a parser change, not a data change: a row the parser cannot read is refused with its reasons, never guessed.

## File

One JSON object with `Items` and/or `PurchaseOrders` and NO other key (a misspelt or re-cased container, `Purchase_Orders`, `items`, is refused by name; a file with neither is refused). `Items` and `PurchaseOrders` each hold the rows as an array, as one Sage list page
(`{"$totalResults", "$startIndex", "$itemsPerPage", "$resources": [...]}`) or as an array of pages.
A page whose `$totalResults` is more than the rows read, that has a `$next` link, whose `$totalResults` / `$startIndex` is not a whole number, that starts anywhere but where the rows before it end (a first page with `$startIndex` above 0), or a first page with a `$back` link, is a partial export and the file is refused (later pages of an array of pages may carry `$startIndex` and `$back`). Fields not listed below are ignored. Money is a JSON number.

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
| `Lines[].ItemId` (alias `SelectionId`) | optional; must be an item in the file | `item_code` on the line (links `po_items.item_id`), see below |

**Item links.** `bulk_create_purchase_orders` takes `item_code` on a line and refuses the WHOLE batch for an unknown, inactive or other-company
item, so the plan sends `item_code` only for an item it knows is active and sent in this run, or already present, owned by Sage and active
(then BY ITS ID: a code stored with whitespace is trimmed by the PO tool and could resolve to another item, or to none, which fails the whole batch; item codes are compared trimmed throughout the plan). Any other line goes WITHOUT `item_code`, keeps " [item CODE]" in its description (the Sage
code stays readable) and is counted in the report as "line not linked: item inactive" or "item refused"; one such line cannot cost its
batch. A linked line has no suffix. An item the export does not contain still refuses the PO (`line_item_unknown`). A PO found already
there is never changed, so re-running a file imported before the links existed (or while the item was inactive) lists each new link as a
difference (`lines[i].item_id`) rather than adding it. The report's line count is therefore MEASURED in the books after a live run, for the
POs that run created (a dry run reports what the plan would link, labelled planned); POs already there are listed as such and add nothing.
Lines not linked are informational: they never change the exit code or block `--live`, because the Sage item code stays readable in the
description and nothing is lost (an inactive item named on an old PO is common in Sage, and making every such run exit 1 would only teach
people to pass the allow flags without reading).

## Refusals

A row is refused with a code and every reason:
- Row and file shape: `invalid_row`, `duplicate_id`, `duplicate_code`, `duplicate_number`, `category_description_conflict`,
  `category_name_collision`, `unknown_status`, `foreign_currency`, `invalid_text` (a NUL byte or a lone surrogate in a text field: item
  Code / Description / category, PO DocumentNumber / Reference / Comments / supplier name / line description).
- PO lines and items: `line_item_unknown` (a line names an item the export does not contain), `line_item_refused` (a line names an item
  that is refused AND has no readable Code to name it by; a refused item WITH a readable code does not refuse the PO, its line goes
  unlinked), `line_description_too_long` (an UNLINKED line's description with its " [item CODE]" passes 500: nothing is cut).
- Suppliers: `supplier_unresolved`, `supplier_ambiguous` (also when a name search hits its 1000-row cap), `supplier_ref_conflict` (the
  supplier of that name already carries another Sage reference), `supplier_collapsed` (two Sage suppliers resolve to one IsaFlow
  supplier), `supplier_inactive`.
- What the company already holds: `code_held_by_existing_item` (an item the migration did not import, or another Sage item, holds the
  code: the migration only ever updates an item it owns), `ref_code_conflict`, `item_deleted`, `item_has_stock_movements` (an owned item
  with stock movements would change type or tracking), `category_name_in_use` (an IsaFlow category the migration did not import holds the
  name, case-insensitively; it is never renamed or adopted) with its items `category_refused`, `po_number_taken` (another PO carries the
  number), `accountless_under_block_policy`.
- The tools' own validators: `tool_refuses` (the item or PO tool's own validator).
A refused row is reported and not sent; the rest of the file goes on. A batch a tool refuses as a whole (a budget
block, a race) fails the dry run, so nothing is written; its whole message is in the report file, the console shows its start.

## Running it (local databases only)

```
DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/isaflow_test bun --no-env-file scripts/sage-migration/run.ts \
  --company <uuid> --user <uuid> --file export.json [--live] [--report report.json] [--skip-budget-check] [--po-gl-account <uuid>] [--allow-refusals] [--allow-differences] [--run-tag <text>] \
  [--expect-items 383] [--expect-pos 757] [--expect-po-total 80950000.00]
```

Without `--live` it is a dry run and writes nothing. `--live` is NOT started when the dry run shows what the person did not allow: `--expect-*` figures that miss what would be sent, rows refused without `--allow-refusals`, differences without `--allow-differences` (status `live_blocked`, exit 1, nothing written). `--po-gl-account` must name an active, non-header expense account of the company (checked before the dry run). With `--live` (which needs `--expect-items` and `--expect-pos`, 0 if none, so a file that lost a container cannot pass unnoticed) it dry-runs first and goes live only if the dry run is clean. Every batch (category, item and PO) is keyed by the state of the existing rows it touches, so a re-run is a fresh call that finds them unchanged or already there (it writes nothing): a stored answer is only ever replayed for rows that are absent, never one true of an earlier state. If the rows of an earlier run were deleted since, a replayed batch is reported "replayed, rows absent" and fails, and `--run-tag <text>` imports afresh under new keys.
The runner refuses unless `DATABASE_URL` is a local throwaway database (`localGuard.ts`): host 127.0.0.1 or localhost, an
explicit port that is not the IsaFlow Supabase stack's (7770-7776), no query parameters but `sslmode`, and a database named
`isaflow_schema_fixture`, `isaflow_test` or `isaflow_sagemig_*`; `SERVICE_DATABASE_URL`, `PLATFORM_ADMIN_DATABASE_URL` and
`MIGRATION_ADMIN_DATABASE_URL` are held to the same rule when set. `--no-env-file` keeps bun from loading a `.env.local`.
Exit 0 = a clean dry run, or a live run that booked everything it sent; `--expect-*` figures must match what was sent (dry) or
booked (live); no row refused unless `--allow-refusals`; and no PO already in IsaFlow with other figures than Sage, and no owned item
that Sage's values would change, unless `--allow-differences` (a PO found already there is never changed: one Sage has since invoiced
stays as imported until a person closes it). 1 = anything else; 2 = refused start. The dry run is the live run in a rolled-back
transaction: categories, items and POs are all written live inside it, so each PO batch's budget check sees the batches before it.
`--po-gl-account` puts one expense account on every PO line so the budget check judges the lines. `--skip-budget-check` lists the POs
the check would have blocked.

A re-run sets the items and categories the migration owns back to the values it SENDS: **edits made to those fields in IsaFlow after the import
are overwritten** (the report lists each owned item and category that would change, with the fields, and the summary says so). Limit: the
tools never clear a field (a field left out keeps its value), so a value Sage has since DROPPED (a price emptied, a category removed) stays
in IsaFlow, and is not listed: the migration cannot see what it does not send.

Budget policy: a PO line with no GL account is "No budget" and is not judged, EXCEPT under the company's `block` policy, where the PO
tool refuses a whole batch for any approved (open) PO with an account-less line. The plan reads the policy and refuses each such PO
itself (`accountless_under_block_policy`), naming the remedies: `--skip-budget-check` (owner or admin), `--po-gl-account <uuid>`, or
importing open POs as drafts (`OPEN_SAGE_PO_IMPORTED_AS`). Other codes: `supplier_collapsed` (two Sage suppliers that resolve by name
to one IsaFlow supplier are both refused).

## Named limits

- **The snapshot race.** What the company already holds (item codes, PO numbers, supplier references) is read once, before the dry
  run, and the plan refuses rows against it. A writer that adds a clashing row between that read and the live batch can still make a
  tool refuse a batch. The dry run reports such a refusal and writes nothing; a live batch that hits it is reported failed with the
  tool's whole message, nothing of it written, and running again resumes.
- **Other causes that can still fail a PO batch as a whole:** a PO that is really over budget under `block` (the dry run reports it
  and nothing is written), and a supplier merged into another or deleted after the snapshot (the tool refuses the batch).
- **`--po-gl-account` posts every PO line to that one account.** It is opt-in; the default is no account, and a line with none is
  "No budget" (not judged; under `block` an approved one is refused, see above). With the flag the budget check, and so what a PO commits, is only as right as that one choice: a line
  that Sage would have coded elsewhere is judged against this account's budget.
- **The ownership window.** The dry run's item outcomes are checked against the snapshot (an item that came back `updated` for a Sage id
  the migration did not own, or `created` for one it did, fails the dry run naming the row), which closes the gap between the snapshot
  and the dry run. A writer that adds an item with an export code between the dry run and a live batch can still be overwritten by
  that batch: the tool matches by code. External systems of items and categories are compared exactly (case-sensitive `sage`), as
  those tools do; PO and supplier lookups are case-insensitive, as theirs are.
- **Exit codes.** 3 = the run finished but `--report` could not be written (the summary is printed before the report is written).
- **Batches follow IsaFlow's state.** Every batch's idempotency key (category, item and PO: one shared salt, `stateSalt`) is salted with a hash of the state of the existing rows it touches (for a PO: the fields the PO tool compares, its line items and updated_at), so
  once a person has changed an owned item in IsaFlow the batch is not replayed from the stored answer of the run that wrote it (that would
  write nothing and leave the item as the person left it, while the dry run said it would be put back). With no owned row (a first run, or
  rows deleted) the key is the plain one, so a failed batch still resumes under its key. After the items phase the books are also checked
  against what was sent (code, active flag, type, tracking); on a mismatch the PO phase is not started. The report's differences list
  combines the dry run's findings with the live run's.
- **One run per company.** A session advisory lock is held on its own connection for the whole run, dry runs included. A second run for the
  same company is refused at its start ("another Sage migration is running for this company", exit 2) and writes nothing; other companies
  are not held up. The lock goes with its connection if the process dies.
