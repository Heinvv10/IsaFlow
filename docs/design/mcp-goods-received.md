# MCP goods received notes (section 3)

Status: design, 2026-11-20. Builds on the PO bill links (#1627) and PO maintenance (#1665) work, both on master.

## Tools

| Tool | Kind | Scope |
|---|---|---|
| `create_goods_received` | write | write:invoices |
| `cancel_goods_received` | write | write:invoices |
| `list_goods_received` | read | read |
| `get_goods_received` | read | read |

Both writes are free flows (`purchaseOrderFlow.ts`), like the PO tools. No new scope, so no connector re-consent.

`create_goods_received(po_id, received_date, received_by?, notes?, lines[{po_item_id, quantity_received, quantity_rejected?, notes?}], external_system?, external_ref?, idempotency_key, dry_run?)`

- It runs `createGoodsReceived` (the service the app's POST uses), so the rules are the same: the PO must be `approved` or `partially_received`; `quantity_received` must not exceed the line's ordered quantity less what was already received (rejected goods do not count against it); every line must belong to the PO; and no PO line may appear twice. The PO status is then recomputed to `partially_received` or `received`.
- Numbering stays the existing `GRN-00001` sequence, under number lock 620.
- `external_system` + `external_ref` are optional. When given, they are unique per company among GRNs that are not cancelled. A repeat names the existing GRN in a refusal (`duplicate_external_ref`) and writes nothing. FibreFlow site deliveries send `external_system: "fibreflow"`.
- Refusals are typed and per line (`po_not_receivable`, `over_receipt` with the line, outstanding and asked quantities, `line_not_on_po`, `duplicate_line`, `duplicate_external_ref`, `not_found`). They are all-or-nothing: if any line is refused, nothing is written.
- `dry_run` runs the real service in a rolled-back savepoint and reports `grn_number` as "next". It sets `wroteNothing` and does not consume the idempotency key.

`cancel_goods_received(grn_id, reason, idempotency_key, dry_run?)`

- It sets the GRN to `cancelled` (with `cancelled_at`, `cancelled_by` and `cancel_reason`), subtracts each item's `quantity_received` from its `po_items.quantity_received`, and recomputes the PO status (`received` → `partially_received` / `approved`).
- It refuses when:
  - the GRN is already cancelled (`already_cancelled`);
  - the PO is `closed` or `cancelled` (`po_not_receivable`; set the PO status back first);
  - a bill that is not deleted carries this GRN in `supplier_invoices.grn_id` (`grn_on_bill`, naming the bills). The exit is to edit those bills' GRN link, then cancel.
- Billed quantity above received quantity is allowed after a cancel, as it already is when a bill arrives before the goods do.
- Managers and above may cancel. The commitment is unchanged, because `approved`, `partially_received` and `received` all count as committed.

`list_goods_received(po_id?, supplier_id?, date_from?, date_to?, external_ref?, status?, limit, offset)` returns notes with their PO number, supplier, line count and document count. `get_goods_received(grn_id)` returns the note, its items (with the PO line description, ordered and received quantities), its attachments, and the bills that carry its `grn_id`. Cancelled notes are listed with `status: cancelled`.

## GL

A GRN does not post to the general ledger. It records quantities only: there is no GRNI accrual and no stock movement journal. The ledger moves when the bill is approved. Both tools' descriptions say so, and an integration test asserts that create and cancel leave `gl_journal_entries` and `gl_journal_lines` unchanged.

## Lock order

Create and cancel both take number lock 620, then the PO `FOR UPDATE`, then `po_items FOR UPDATE`, then the GRN row (cancel only). That is the same order the app's POST uses, and it fits the census in `mcp-po-bill-links.md`: lock 620 sits before the PO rows, and nothing takes 620 after a PO lock.

## Migration

- Add `cancelled` to `goods_received_notes_status_check`.
- Add the columns `cancelled_at`, `cancelled_by`, `cancel_reason`, `external_system` and `external_ref`.
- A CHECK keeps the cancel columns consistent: they are set if and only if the status is `cancelled`, and a reason is required.
- A partial unique index on `(company_id, external_system, external_ref)` covers non-cancelled notes that have an `external_ref`.
- A trigger refuses moving a note out of `cancelled`, refuses editing a cancelled note's items, and refuses inserting items into a cancelled note.

## Attachments

`goods_received` becomes an entity-store kind: it is added to `AccountingEntityType`, to the ownership check, to `ENTITY_TARGET_KINDS` (create_upload_urls / finalize_uploads), and to `attach_entity_document`, with the default document type `delivery_note`. If that type is not in `VALID_DOCUMENT_TYPES`, it is added there. `find_by_external_ref` gains the kind `goods_received`.

## Acceptance tests (integration, app_user role)

1. On a PO for 10, receiving 6 makes it `partially_received`; receiving 4 more makes it `received`; GRN numbers go up by one.
2. Receiving 1 more after that is refused with `over_receipt`, and nothing is written.
3. Cancelling the second GRN restores `quantity_received` to 6 and the status to `partially_received`. Cancelling the first restores 0 and `approved`.
4. Cancel is refused for a GRN on a bill, for an already-cancelled GRN, and for a GRN on a closed PO.
5. A GRN PDF attaches through create_upload_urls → finalize_uploads, and get_goods_received lists it.
6. Another company's PO or GRN is refused as `not_found`. Lists never show another company's notes.
7. A repeated `external_ref` is refused and names the first GRN. After that GRN is cancelled, the ref can be used again.
8. dry_run writes nothing, and a live call with the same key then succeeds.
9. The GL is unchanged by create and by cancel.
10. Racing two creates for the same remaining quantity: one succeeds and the other is refused as `over_receipt`.
