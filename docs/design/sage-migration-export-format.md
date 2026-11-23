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
| `Lines[].LineType` | optional; **ASSUMED, unconfirmed against a real export**: Sage One API v2 `PurchaseOrderLine.LineType`, 0 = item line, 1 = account line. Absent or 0: an item line, as above. 1: the PO is refused (`po_account_line_unsupported`, naming the account id): its SelectionId is a ledger ACCOUNT and Sage numbers entity types separately, so it can equal an item's id. Any other value: refused (`po_line_type_unknown`). A line that is not known to be an item is never linked to one | the line is read, never linked, when refused |

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
- **A booked PO whose Sage supplier no longer resolves** (renamed, merged, deactivated or deleted in IsaFlow; suppliers are matched by Sage reference, else by name) is NOT refused on a re-run: it is sent (the tool replays it) under the supplier it is booked to, and listed in `differences.purchaseOrders` as `supplier_id: Sage supplier N "name" not found in IsaFlow (...); PO is booked to <name> (<id>)`, so a real supplier move is never hidden. If the booked supplier is DELETED the tool answers Not found for the whole batch, so that PO is refused (`booked_supplier_deleted`) with the remedy (restore the supplier, or give it the Sage reference). A Sage PO reference carried by more than one IsaFlow PO (nothing makes it unique) refuses the PO (`po_ref_ambiguous`, naming the numbers). A tool answer that succeeds but is not a JSON object fails the batch.
- **Supplier carried by two live suppliers.** `find_by_external_ref` answers the first live match and lists the others; two live IsaFlow suppliers on one Sage reference refuse every PO naming it (`supplier_ambiguous`, naming both ids), never a guess.
- **A line's link follows the state the items phase leaves.** A sent item counts as active when SAGE says it is active (the item batch sets it active again, whatever IsaFlow held), so its lines are linked by code; inactive in Sage too, they go unlinked and the book's link is a listed difference. An owned item NOT sent keeps its IsaFlow state. The stored link of an owned item is looked up by its Sage reference (a rename in IsaFlow changes nothing).
- **A lost run lock stops the next batch.** The lock is asked before EVERY batch (the connection's own error flag, and one `SELECT 1` bounded by 10 s), before the live phase and between phases. A dropped connection that reports itself stops the run before the next batch; a half-open one is noticed within the timeout, so at most one batch can be in flight beyond the loss. `unlock` is bounded the same way (a dead connection cannot hang the end of the run: the connection is destroyed).
- **`--expect-po-total` before a live run** is compared with the PROJECTED booked total (the booked total of a PO already there, which an allowed difference keeps, plus the sent totals of new ones), so a run the gate lets through does not then miss its own figure (`MISMATCH purchaseOrderTotalCents: expected X, projected Y`). `--expect-items` / `--expect-pos` stay what is SENT.
- **Open question for the real export: PO line types.** The assumed format has an OPTIONAL `Lines[].LineType` (0 = item, 1 = account: an assumption taken from Sage One API v2, to be confirmed against the real export; the export may name it differently or not carry it at all). With it, an account line is refused with its account id (`po_account_line_unsupported`) and any other type is refused (`po_line_type_unknown`): a non-item line is never linked to an item. WITHOUT it a line cannot be told from an item line, so a ledger-account line reads as an item whose id the export may not contain (`line_item_unknown`, the reason says so) or, worse, equals one (then it would be linked: the reason a real export's line-type field must be found before this runs on real data).
- **Duplicates behind an invalid row.** An ID, Code (item) or DocumentNumber (PO) that another row carries, valid or not, refuses every VALID row that uses it (`duplicate_id` / `duplicate_code` / `duplicate_number`, the reason says another row with it is invalid); the invalid row keeps its own `invalid_row`. A row whose ID or Code is unreadable makes no claim on any.
- **What a re-run compares of a PO already in the books.** The PO tool compares number, date, total, status and item links only. The plan keeps, for every PO it sends, the COMPLETE row set the tool would write (its own parse of the element: a line's stored unit price is net / quantity to 6 decimals, so a discount line, a 3-decimal price or a repeating price is not a false difference), and the runner compares it column by column with the same columns read from the books before the run: `purchase_orders` po_number, supplier_id, order_date, expected_delivery_date, status, subtotal, tax_amount, total, reference, external_system, external_ref, external_document_number; each line, by position, description (without its own exact " [item CODE]" suffix), quantity, unit_price, tax_rate, line_total, tax_amount, item_id (the link the plan would send: the item's id, null when unlinked) and sort_order; and the line count. Any difference is listed under `differences.purchaseOrders` (so it counts in the exit code and the live gate like the tool's own), keyed by the number the books hold, once (a fact the tool already reported is not repeated). Nothing is rewritten. **The column lists are the contract** (`sagePoContent.ts`): every column of both tables is compared or EXCLUDED with a reason (ids, who/when, goods received and invoiced since, the company scope, and the IsaFlow-owned coding of a line: gl_account_id, cc1_id, cc2_id, bu_id, which Sage has no field for, so a line a person codes in IsaFlow never blocks a re-run), and `tests/integration/sage-migration-po-columns.int.test.ts` fails when a table has a column in neither list, or when the PO tool's own INSERT writes one that is. Named limits: zero-rated versus exempt (both 0%) is neither stored nor detected (the tool stores the rate only); `notes` is excluded (people edit it, and the importer writes the Sage status text into it, which `status` covers), so a change of the Sage Comments is not detected.
- **"Already booked" is decided by the Sage reference**, as the tool replays: a booked PO renumbered in Sage (or two whose numbers were swapped) is not refused for its number, supplier or the policy; the number is a difference. `--allow-differences` and `allSentBooked` agree (by reference).
- **One Sage supplier id under several names.** Every distinct name the export gives it is searched and what they find is pooled: one IsaFlow supplier is the answer, two or more refuse all its POs (`supplier_ambiguous`), whichever row comes first.
- **A stop lists only what it can stand behind.** The batches it calls committed are checked against the books first: a replayed answer whose rows are gone is listed as `replayed: rows absent, nothing written (use --run-tag ...)`, and an ok batch that WROTE NOTHING (its rows were all there already and the tool answered unchanged / `written: false`) as `answered ok, nothing new written`; an item batch the tool UPDATED (an allowed difference, put back to Sage's values) is `committed`. A PO batch is never rewritten, so a PO batch of rows already there is listed as answered ok.
- **Pool.** The run lock holds one connection for the whole run and the tool sessions need others, so a pool of fewer than 2 connections is refused at the start. The lock session also sets `idle_session_timeout` to 0 for itself (reset on unlock) and is pinged every 15 s.
- **Exit codes.** 0 = ok; 1 = not ok (blocked, refusals or differences not allowed, figures off); 2 = refused or failed to START, nothing written (bad arguments, not a local database, another run holds the lock); 3 = the run finished but `--report` could not be written (the summary is printed before the report is written); 4 = the run STOPPED on an error after its live phase started (a lost connection, a lost run lock), or finished with a live batch whose COMMIT did not answer (the summary says `COMMIT UNCONFIRMED: ... check the books`): batches may be committed, the message lists them, and a re-run resumes.
- **Flows.** Every registry tool the runner calls (`list_suppliers`, `find_by_external_ref`, `upsert_item_category`, `bulk_upsert_items`, `bulk_create_purchase_orders`) is free in `flowMetering` (`null` operation), so a dry run and a live run cost a PAYG company 0 Flows and a wallet that runs out cannot stop a run mid-way (a test asserts the wallet is unchanged). If a tool were ever metered, the debit is refunded when the call fails or its request rolls back (the dry run), but a committed batch keeps its charge.
- **Batches follow IsaFlow's state.** Every batch's idempotency key (category, item and PO: one shared salt, `stateSalt`) is salted with a hash of the state of the existing rows it touches (for a PO: the fields the PO tool compares, its line items and updated_at), so
  once a person has changed an owned item in IsaFlow the batch is not replayed from the stored answer of the run that wrote it (that would
  write nothing and leave the item as the person left it, while the dry run said it would be put back). With no owned row (a first run, or
  rows deleted) the key is the plain one, so a failed batch still resumes under its key. After the items phase the books are also checked
  against what was sent (code, active flag, type, tracking); on a mismatch the PO phase is not started. The report's differences list
  combines the dry run's findings with the live run's.
- **One run per company.** A session advisory lock is held on its own connection for the whole run, dry runs included. A second run for the
  same company is refused at its start ("another Sage migration is running for this company", exit 2) and writes nothing; other companies
  are not held up. A PO this migration already booked is never refused on a re-run for a supplier deactivated, or a budget policy turned to block, since (`supplier_inactive` and `accountless_under_block_policy` are for new POs; the tool replays the booked one), so `--expect-pos` still counts it. The lock goes with its connection if the process dies. The connection is watched: an error on it is recorded (it does not kill the process), and the run checks it before the live phase and between phases; if it is gone the run stops with "the run lock is lost" (exit 4, committed batches listed), because another run could now start.
