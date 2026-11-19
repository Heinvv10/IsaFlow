# MCP: purchase-order maintenance (section 4 of the 19 Nov PO brief)

Why: after the 757 Sage POs load (#1591) and their bills link (#1627), a person must be able to correct, cancel and finish a PO
without the app: edit an open PO, cancel one, short-close one the supplier will not finish, and fix the status of an imported
PO the source system has moved on. Stacked on #1627 (`feat/mcp-po-bill-links-20261119`): the lock-order census there is
the one this note extends.

Status: decisions of Hein's brief and his 19 Nov rulings; built in the same branch (migration `1007`, tools `update_purchase_order`,
`cancel_purchase_order`, `close_purchase_order`, `set_purchase_order_status`, the `bulk_create_purchase_orders` changes). Kept in step
with the code.

## Tools (all `write:invoices`, free, post NOTHING)

Scope: the existing `write:invoices` (as `bulk_create_purchase_orders` and the link tools). **No new scope, so no connector
needs to be re-consented.** A new scope would have; that is why none was added. Every tool: company guard (ids resolve only
inside the caller's company; another company's PO reads "not found"), `idempotency_key`, `dry_run` that runs the REAL service
in a rolled-back savepoint (`inRolledBackSavepoint`, every guard) and sets `wroteNothing` / `billable: false` so the key stays
free, one audit row (`purchase_order`), typed refusal `PURCHASE_ORDER_MAINTENANCE_REFUSED` (registered in `REFUSAL_CODES`),
flow metering free (`purchaseOrderFlow.ts`). No `gl_journal_*` row is written by any of them (asserted by count).

1. **`update_purchase_order`** - `po_id | po_number`, header fields `supplier_id`, `order_date`, `delivery_date`, `reference`,
   `notes` (omitted = unchanged, `null` clears), `lines` (REPLACE every line; omitted = lines and totals unchanged),
   optional `expected_totals`.
   - Statuses: **draft, submitted and approved.** The app's PUT edits draft and submitted (any writer), so those two are parity;
     approved is new (the PUT refuses it and no app action edits an approved PO) and is **owner / admin only** (Hein's R1: an
     edit changes what the PO commits), refused after one status read, before the edit is validated, locked or written, dry run
     too. partially_received / received / closed / cancelled are refused with the status.
   - On an approved PO the edit RESTAMPS `approved_by` / `approved_at` to the editor (they approved what it now says); the previous
     approver and time are in the audit row (`prior_approved_by` / `prior_approved_at`). Under the BLOCK policy every replacement
     line needs a `gl_account_id` (a line with none cannot meet a budget and would escape the re-check). The SAME rule holds for
     every MCP writer of an approved PO (`ACCOUNTLESS_REFUSAL`; NOT the app's Approve action, which accepts account-less lines as "No budget" by P5-3 census 7, since the PO create route writes them): the import (an open PO: the batch is refused, dry run too) and
     `set_purchase_order_status` -> approved (stored lines); warn and a draft allow it. `skip_budget_check_for_import` lets an import
     through and reports the PO as `would_have_failed` with that reason. The audit row records the prior lines of a replacement
     (`prior_lines`: account, dimensions, quantity, ex-VAT amount, the first 20, `prior_lines_total`). The re-check judges the
     NEW lines in the order date's (new) month; the month the PO leaves only loses commitment, which cannot put anything over.
   - Lines: as `bulk_create_purchase_orders` (`description`, `quantity`, `unit_price`, `tax_rate`, source `line_total` /
     `tax_amount`, `gl_account_id`, `cc1` / `cc2` / `bu` as code / alias / UUID) plus `item_id` or `item_code` (migration 1005:
     a line naming an item and no account takes the item's purchases account and, with no rate, the item's VAT type;
     `purchaseOrderItemLines`). Priced in cents by the import's rules (`purchaseOrderImportAmounts`); totals are the sums;
     `expected_totals` must equal them to the cent. A line with no `cc1` / `cc2` / `bu` has none (replace, not keep).
     NOTE: in this base `bulk_create_purchase_orders` does not itself accept `item_id` / `item_code` (its line keys refuse them);
     only the update does. Adding them to the import is a small follow-up (one decision: `po_items.item_id` is written by
     `purchaseOrderLinesWrite`, which both writers now share).
   - **Refused when the PO has any goods receipt, or any bill link** (a `purchase_order_bill_links` row, a bill line naming one of
     its lines by `po_item_id` - no FK holds that column): replacing lines would orphan them. A bill that names the PO ONLY in its
     header (no link row, no line) is a tie only when `link_bills_to_purchase_order` COULD link the pair (PO approved /
     partially_received / received / closed, bill approved / paid / partially_paid and not deleted, same supplier): such a bill is
     billing the PO (the three-way match reads the header PO's lines) but was made while the PO was only submitted, and approving
     writes no link. Refusal: "link it first (link_bills_to_purchase_order)" (also in `set_purchase_order_status` -> draft / cancelled); the way out
     is to link it and, if it was wrong, unlink it (the unlink resets the header). When the default link amount would be 0 (the bill
     is already fully linked elsewhere, or has no subtotal), link with an explicit `amount: 0.01` (within the +1c the link rule
     allows), then unlink; the text says so. A CANCELLED bill's line is no tie either (the link tool and the backfill skip cancelled
     bills, so nothing could clear it; billed / committed read approved / paid / partially_paid bills only). A header reference the link tool could not link (a draft / submitted / cancelled PO, a draft
     or cancelled bill, another supplier) is no tie: nothing bills the PO and nothing could clear it (round 3, no dead end).
     "Unlink the bills (`unlink_bill_from_purchase_order`) / cancel the receipt first". A supplier change on a linked PO is
     refused by the existing database guard and, first, by `poSupplierChangeBlocked`.
   - Validation is the PUT's, extracted, not copied: `ap/purchaseOrderEditChecks.validatePoEdit` (supplier in company, supplier
     change blocked, item resolution, the account guard with its kept-account exemption, line dimensions) is now called by the
     PUT and by this tool, same order, same errors.
   - **Budget (Hein, 19 Nov):** an update of an APPROVED PO can raise its commitment, so it re-runs the PO approval check
     (`checkPurchaseOrderBudget`, channel `mcp`, the Approve action's block / warn behaviour) on the NEW lines under the budget
     gate, after the write inside the savepoint: a block refuses and rolls the edit back (its `refused` event is recorded outside
     the savepoint, as the MCP bill approve does), a warn returns `budget_warnings`. A draft / submitted edit commits nothing and
     is not checked. A header-only edit of an approved PO re-checks only when the order date moves to another month (the month is
     what the lines are judged against); a notes / reference / delivery edit commits nothing new, so an approved PO that has since
     gone over budget can still be annotated under block.
2. **`cancel_purchase_order`** - `reason` required (audited, `source: mcp:cancel_purchase_order`). Draft / submitted: cancelled as
   the PUT does (any writer), now audited and row-locked, and refused (like an approved one) while a receipt or any bill tie
   stands (the same wide check as the update: a link row, a bill line naming a PO line, a bill naming it). Approved: `cancelApprovedPurchaseOrder` (**owner / admin only**, `PO_CANCEL_ROLES`; refuses with a
   receipt and, since #1627, with bill links - "unlink first"). partially_received / received / closed / cancelled: refused
   with the status.
3. **`close_purchase_order`** (short close) - approved / partially_received / received -> `closed`, `reason` required,
   **owner / admin only** (closing releases commitment; Hein's R1 for link-close). Records the status it came from in the new
   column `purchase_orders.closed_from_status` (migration **1007**, below). NOTHING restores a status from it today: it is a record
   for a person (`get_purchase_order` shows it) and for a future reopen tool. Audit row:
   `status_before`, received and billed ex-VAT amounts at that moment, the reason. The reply lists, per line that was
   short-closed, the ordered-not-received quantity and ex-VAT amount. Bills and links stay.
4. **`set_purchase_order_status`** - for IMPORTED POs: target `draft | approved | closed | cancelled`, `reason` required,
   **owner / admin only**, audited (old -> new). Refused unless the PO carries `external_ref`, when it has a goods receipt, and
   for a move that would orphan bill links (-> draft or -> cancelled while links exist). **-> closed only from approved** (closing
   a draft / submitted / cancelled PO would make it billable without it ever having been approved; the import creates closed POs
   directly). **Leaving closed clears the closing records on the PO's links** (`closed_po_from_status`, 1006), so a later unlink
   cannot reopen a PO someone deliberately reopened and closed again (review M3; the 4-step case is tested). -> approved runs the budget check
   NORMALLY (the import's `skip_budget_check_for_import` does not apply: a status fix is not a load) and stamps
   `approved_by` / `approved_at`; -> closed records `closed_from_status` (always `approved`) as `close_purchase_order` does; leaving
   closed clears it. The audit row of a set status that leaves closed names the links whose closing record it cleared
   (`cleared_link_records`, `cleared_links`: link id, bill, what the record said).
   partially_received / received are never targets (they come from receipts) and refused as sources.
5. **`bulk_create_purchase_orders` changes:**
   - `dry_run` reports per PO `budget_check` (`outcome` ok | warn | block, `policy`, `reasons`; null for a PO that is not
     imported approved) decided by the same check the live call runs (`reasons` lists the first 10, `reasons_total` counts them all),
     and the existing `dimension_warnings` per PO. A PO reported as `block` does not count as committed for the POs after it (they
     are judged as the live call would judge them without it); with the skip flag it does (it is created). A PO the live
     call would refuse on a block no longer fails the dry run: it comes back `would_succeed: false` with the blocked POs listed.
     (The live call still refuses the whole batch.)
   - New `skip_budget_check_for_import` (**owner / admin only**, refused for anyone else before any read, dry run too): an
     approved PO skips the BLOCK. The check is still evaluated, so each approved PO reports `budget_check_skipped: true` and
     `would_have_failed` with the reasons, live and dry run alike; the PO's create audit row (one per PO) carries
     `budget_check_skipped` / `would_have_failed` / the reasons. No budget event row is written for the skipped block (the
     event table has no "skipped" outcome and no migration was added for it).

## Migration 1007: `purchase_orders.closed_from_status`

`TEXT NULL`, CHECK `closed_from_status IS NULL OR (status = 'closed' AND closed_from_status IN (approved, partially_received,
received))`: it holds a value only while the PO is closed. No existing column fits: the link table's `closed_po_from_status`
belongs to a link and a short-closed PO may have none. Written by close / set status (-> closed), cleared in the same UPDATE by
every writer that moves a PO out of closed (set status; the unlink's reopen). A close made by `link_bills_to_purchase_order`
(`close_when_fully_billed`) does NOT set it: that closing is recorded on the link. The old colour never writes or reads it, and `SELECT po.*`
readers pass it through. `get_purchase_order` shows it. 1007 was free on every branch, worktree and open PR on 19 Nov (1008
is `feat/invoice-line-vat-schema-readers-20261119`).

## Lock-order census (extends #1627's)

| Writer | Order |
|---|---|
| bill create (REST / MCP, `createSupplierInvoice`) | the named POs `FOR KEY SHARE` in id order, re-checking the PO lines under it (review M1: before this, an update could replace the lines between the check and the line insert), BEFORE the bill and its lines are written; the bill row is new, so no other writer can hold it first; then `recordBillLinks`' same KEY SHARE (re-entrant). The wait is bounded like every PO lock (5 s, typed `PURCHASE_ORDER_LOCK_TIMEOUT`, 503): the REST route has reserved the bill number by then, but a 503 rolls the request transaction back with the reservation, so no number is burned; the MCP create reserves none |
| `update_purchase_order` | prepare reads (account rows `FOR SHARE`, items, suppliers) -> budget gate (**approved PO only**, block policy only) -> PO row `FOR UPDATE` -> reads of receipts / links / bill lines (no bill row locks) -> writes -> budget check (reads) |
| `cancel_purchase_order` | PO row `FOR UPDATE` (draft / submitted / approved: the existing "PO cancel" row) |
| `close_purchase_order` | PO row `FOR UPDATE`; reads links (no bill locks); takes no budget gate (releasing a commitment cannot overspend) |
| `set_purchase_order_status` | budget gate (-> approved, block only) -> PO row `FOR UPDATE` |
| `bulk_create_purchase_orders` | unchanged: budget gate (an approved PO) -> counter row -> external-ref advisory locks |

No cycle: every writer that takes the budget gate takes it first. The update reads the PO's status BEFORE the gate to decide
whether to take it; under the row lock it re-reads, and a draft that became approved meanwhile is a typed 409 retry
(`PURCHASE_ORDER_CHANGED`), because taking the gate after the row would invert the order. None of the four takes a bill row, so
they cannot meet the link / unlink bill-row order; each serialises with link / unlink / approve / cancel / goods receipt on the
PO row (link and unlink hold it `FOR NO KEY UPDATE`, which still conflicts with `FOR UPDATE`).

## Known limits

- Short-closing a partially_received / received PO drops goods received and not yet billed from committed spend (committed counts
  open PO lines only); a bill for them can still be created: bill lines naming a line of a CLOSED PO are accepted
  (`assertBillPoLinks` takes `LINKABLE_PO_STATUSES`, as the link tool does), but, closed POs committing nothing, they net nothing.
- An approved PO's update checks the budget after the write (inside the savepoint) where the Approve action checks before it;
  the outcome is the same, a refusal leaves nothing.
- A not-cancelled bill line naming a PO line with no link row (a row removed by hand) ties the PO for the guards but unlink answers "not linked" for it; the app's create/edit always writes the app link, so this needs data that bypassed them.
- Remaining quantity on close is ordered less received; bills are not netted (a bill line links to a PO line, receipts do not).
