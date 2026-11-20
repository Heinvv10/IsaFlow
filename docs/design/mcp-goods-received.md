# MCP goods received notes (section 3)

Status: design, 2026-11-20. Builds on the PO bill links (#1627) and PO maintenance (#1665) work, both on master.

## Tools

| Tool | Kind | Scope |
|---|---|---|
| `create_goods_received` | write | write:invoices |
| `cancel_goods_received` | write | write:invoices |
| `list_goods_received` | read | read:invoices |
| `get_goods_received` | read | read:invoices |

Both writes are free flows (`purchaseOrderFlow.ts`), like the PO tools. No new scope, so no connector re-consent.

`create_goods_received(po_id, received_date, received_by?, notes?, lines[{po_item_id, quantity_received, quantity_rejected?, notes?}], external_system?, external_ref?, idempotency_key, dry_run?)`

- It runs `createGoodsReceived` (the service the app's POST uses), so the rules are the same: the PO must be `approved` or `partially_received`; `quantity_received` must not exceed the line's ordered quantity less what was already received (rejected goods do not count against it); every line must belong to the PO; and no PO line may appear twice. The PO status is then recomputed to `partially_received` or `received`.
- Numbering stays the existing `GRN-00001` sequence, under number lock 620.
- `external_system` + `external_ref` are optional. When given, they are unique per company among GRNs that are not cancelled. A repeat names the existing GRN in a refusal (`duplicate_external_ref`) and writes nothing. FibreFlow site deliveries send `external_system: "fibreflow"`.
- Refusals are typed and per line (`po_not_receivable`, `over_receipt` with the line, outstanding and asked quantities, `line_not_on_po`, `duplicate_line`, `duplicate_external_ref`, `not_found`). They are all-or-nothing: if any line is refused, nothing is written.
- `dry_run` runs the real service in a rolled-back savepoint and reports `grn_number` as "next". It sets `wroteNothing` and does not consume the idempotency key.

`cancel_goods_received(grn_id, reason, idempotency_key, dry_run?)`

- It sets the GRN to `cancelled` (with `cancelled_at`, `cancelled_by` and `cancel_reason`), subtracts each item's `quantity_received` from its `po_items.quantity_received`, and recomputes the PO status (`received` → `partially_received` / `approved`). These three happen in one SECURITY DEFINER function, `goods_received_note_cancel` (see Database rules); the service keeps the guards that name things, the locks and the audit row.
- It refuses when:
  - the GRN is already cancelled (`already_cancelled`);
  - the PO is `cancelled` (`po_not_receivable`). A cancelled PO carries only cancelled notes (`cancel_purchase_order` and `set_purchase_order_status` refuse a PO with a live one), so a live note there was put by hand, and no tool mends it: the refusal says so and points to IsaFlow support rather than to a status change that does not exist;
  - taking the note off would leave a PO line with less received quantity than the PO's other live notes still account for (`receipts_disagree`, naming the lines with `line_received`, `note_received` and `other_notes_received`; the line's total was not written with the notes). This also covers a line that would fall below zero. Nothing is written;
  - a bill that is neither deleted nor cancelled (a NULL status counts as live: `IS DISTINCT FROM 'cancelled'`) carries this GRN in `supplier_invoices.grn_id` (`grn_on_bill`, naming the bills). The exit is to cancel or delete those bills (a paid bill needs its payment reversed before it can be cancelled), then cancel the note. Nothing edits a bill's `grn_id`.
- A note on a **closed** PO cancels. The PO stays closed (closing is a decision, and no tool reopens a PO that has receipts), the quantities come back as usual, and the answer carries `receipt_status`: what the receipts now give (`received` / `partially_received` / `approved`). The records of the status the PO was closed from follow it, so a later reopen lands right: `purchase_orders.closed_from_status` (1007, set when closed by hand) and `purchase_order_bill_links.closed_po_from_status` (1006, set when a link closed it; a closing record is moved, not rewritten, so it is cleared and set again).
- Billed quantity above received quantity is allowed after a cancel, as it already is when a bill arrives before the goods do.
- Managers and above may cancel. The commitment is unchanged, because `approved`, `partially_received` and `received` all count as committed.
- A PO whose notes are all cancelled has no receipt: `cancel_purchase_order` and `update_purchase_order` (header) work again (review M2). A cancelled note keeps its items, which reference the PO's lines, so replacing those lines and setting an imported PO back to draft (where the PUT replaces lines and the DELETE removes the PO) stay refused, naming the cancelled note.

`list_goods_received(po_id?, supplier_id?, date_from?, date_to?, external_ref?, status?, limit, offset)` returns notes with their PO number, supplier, line count and document count. `get_goods_received(grn_id)` returns the note, its items (with the PO line description, ordered and received quantities), its attachments, and the bills that carry its `grn_id`. Cancelled notes are listed with `status: cancelled`.

## GL

A GRN does not post to the general ledger. It records quantities only: there is no GRNI accrual and no stock movement journal. The ledger moves when the bill is approved. Both tools' descriptions say so, and an integration test asserts that create and cancel leave `gl_journal_entries` and `gl_journal_lines` unchanged.

## A bill's GRN (review M1)

`supplier_invoices.grn_id` has NO foreign key (migration 201 created it without one; 246b's `ADD COLUMN ... REFERENCES` was skipped because the column existed), so the database ties nothing. The one writer is `createSupplierInvoice` (the REST create; MCP, bulk, import, recurring and capture creates never set it; no update writes it), plus the undo of a soft-deleted bill, which makes a bill live again. Both go through `ap/billGoodsReceivedLink.ts`:

- the create refuses a malformed id, a note that is not this company's (or does not exist) and a cancelled note (`SUPPLIER_INVOICE_GRN_REFUSED`, 400; the REST route checks ahead of its number reservation too);
- the undo refuses a bill whose note (of this company) was cancelled while the bill was deleted;
- both hold the note `FOR SHARE` (`goods_received_note_hold`) and judge it under that lock. The cancel takes the note `FOR UPDATE` and then looks for live bills, so exactly one wins: never a cancelled note with a live bill.

Decided: a typed check under a row lock, not a foreign key. Adding the FK means validating whatever production holds (dangling ids are possible after 201) and still would not see the note's status.

## Lock order

Create and cancel both take number lock 620, then the PO `FOR UPDATE`, then `po_items FOR UPDATE`, then the GRN row (cancel only, inside the function). That is the same order the app's POST uses, and it fits the census in `mcp-po-bill-links.md`: lock 620 sits before the PO rows, and nothing takes 620 after a PO lock. A bill takes the note LAST: the create after every PO row it locks (`assertBillPoLinks`, `recordBillLinks`), the undo after the bill row. Taking it before `recordBillLinks` deadlocked against a cancel when the bill named the note's PO (reproduced in `mcp-goods-received-bills.int.test.ts`); the ranks are bill < PO < note for everyone.

## Migration

- Add `cancelled` to `goods_received_notes_status_check`.
- Add the columns `cancelled_at`, `cancelled_by`, `cancel_reason`, `external_system` and `external_ref`.
- A CHECK keeps the cancel columns consistent: they are set if and only if the status is `cancelled`, and a reason is required.
- A partial unique index on `(company_id, external_system, external_ref)` covers non-cancelled notes that have an `external_ref`.
- A trigger refuses moving a note out of `cancelled`, refuses editing a cancelled note's items, and refuses inserting items into a cancelled note.
- A trigger (`grn_items_same_transaction_guard`) refuses inserting an item onto a note that was not created in the same transaction (the note's `created_at` is not `now()`, the transaction's start; not `xmin`, which a savepoint changes). Create writes a note, its items and the PO lines' `quantity_received` together; an item added later would leave that total disagreeing with the notes.
- Two more triggers keep a note on one company and one PO: `goods_received_notes_po_guard` (the PO named is a PO of the note's company) and `grn_items_po_line_guard` (an item names a line of its note's PO). A foreign key checks neither.
- `idx_supplier_invoices_grn` on `supplier_invoices (company_id, grn_id) WHERE grn_id IS NOT NULL`: the cancel's check for a live bill scans bills under the PO and note locks.

## Database rules (review M3, L1)

- **Only the cancel changes a note.** No app path UPDATEs or DELETEs `goods_received_notes` or `grn_items` except the cancel, and a trigger keyed on the caller's role can be steered, so app_user loses UPDATE and DELETE on both (a privilege holds). The cancel's state change, quantity reversal and PO recompute run in `goods_received_note_cancel(note, reason)`: SECURITY DEFINER, owner `migration_admin`, `search_path = pg_catalog, public, pg_temp`, EXECUTE for app_user / app_service only, registered in `app_definer_reviews` (930). Inside it: the caller must be a member (`company_users`, `auth.uid()`) of the session company (`app.current_company_id()`), else `not_found`; it takes the create's locks itself and re-decides `already_cancelled`, `po_not_receivable` and `grn_on_bill` under the note lock, answering them as an outcome (nothing written) rather than raising. `cancelled_by` is `auth.uid()`.
- **The hold.** A row lock needs UPDATE privilege, so a bill cannot take `FOR SHARE` on a note itself any more: `goods_received_note_hold(note)` (same definer rules; reads one row of the session company for a member, writes nothing) takes it and returns the status.
- **grn_items row security.** `grn_items` has no `company_id`; it gets row security (FORCE, like its note) with a policy through the note: visible when the note is (the note's own policy), written only onto a note of the session company (WITH CHECK). Create, cancel, get / list, the three-way match and the item-movement report read through it unchanged.

## Attachments

The app's goods received list (`/accounting/goods-received`) shows each note's status as a pill, and a cancelled note's reason under it.

A bill that carries the note (`supplier_invoices.grn_id`) gets the note's documents linked onto it, and its own documents linked onto the note (`autoLinkSupplierInvoice`, entity type `goods_received`; every id read from the bill (its PO, its note) is fenced to the bill's company, since neither carries a foreign key and row security admits every company a user belongs to; links are written with `linked_entity_type = 'goods_received'`, and the legacy `goods_receipt_note` document type is still read).

`goods_received` becomes an entity-store kind: it is added to `AccountingEntityType`, to the ownership check, to `ENTITY_TARGET_KINDS` (create_upload_urls / finalize_uploads), and to `attach_entity_document`, with the default document type `delivery_note`. If that type is not in `VALID_DOCUMENT_TYPES`, it is added there. `find_by_external_ref` gains the kind `goods_received`.

## Acceptance tests (integration, app_user role)

1. On a PO for 10, receiving 6 makes it `partially_received`; receiving 4 more makes it `received`; GRN numbers go up by one.
2. Receiving 1 more after that is refused with `over_receipt`, and nothing is written.
3. Cancelling the second GRN restores `quantity_received` to 6 and the status to `partially_received`. Cancelling the first restores 0 and `approved`.
4. Cancel is refused for a GRN on a bill, for an already-cancelled GRN, and for a GRN on a cancelled PO; a GRN on a closed PO cancels and leaves the PO closed (`mcp-goods-received-closed`). A cancelled or deleted bill frees the note.
5. A GRN PDF attaches through create_upload_urls → finalize_uploads, and get_goods_received lists it.
6. Another company's PO or GRN is refused as `not_found`. Lists never show another company's notes.
7. A repeated `external_ref` is refused and names the first GRN. After that GRN is cancelled, the ref can be used again.
8. dry_run writes nothing, and a live call with the same key then succeeds.
9. The GL is unchanged by create and by cancel.
10. Racing two creates for the same remaining quantity: one succeeds and the other is refused as `over_receipt`.
11. A bill create refuses a cancelled, foreign, unknown or malformed note; the undo of a deleted bill refuses a note cancelled meanwhile; a bill create and a cancel of its note, interleaved both ways and raced, end in one outcome (`mcp-goods-received-bills`).
12. As app_user a forged cancel UPDATE, an item edit and DELETEs of notes or items are refused; no item goes onto another company's note, or onto an existing one; receipts that disagree with their PO line are a typed refusal (`mcp-goods-received-db`).
13. After every note is cancelled, the PO can be cancelled and its header edited (`mcp-goods-received-po-loop`).
