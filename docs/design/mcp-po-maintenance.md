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
   - **Refused when the PO has any goods receipt, or any bill TIE.** A tie is a `purchase_order_bill_links` row, a bill line naming
     one of its lines by `po_item_id` (no FK holds that column; any bill status, draft and cancelled included, soft-deleted
     excluded), or a bill that names the PO ONLY in its header when `link_bills_to_purchase_order` COULD link the pair (PO approved /
     partially_received / received / closed, bill approved / paid / partially_paid and
     not deleted, same supplier: such a bill is billing the PO, the three-way match reads the header PO's lines, but it was made
     while the PO was only submitted and approving writes no link). A header reference the link tool could not link (a draft /
     submitted / cancelled PO, a draft or cancelled bill, another supplier) is not billing the PO and is no tie.
   - **ONE exit, ONE wording (round 5, closing the dead-end class).** Every tie refusal (update, cancel, set status -> draft /
     cancelled) says "unlink it first (unlink_bill_from_purchase_order)", and `unlink_bill_from_purchase_order` clears EVERY kind of
     tie for the (PO, bill) pair in one locked write: the link row if there is one (with the reopen / closing-record / budget-warning
     behaviour of #1627), `po_item_id` on the bill's lines that point into this PO's lines, and the header if it names this PO. It
     succeeds when any of the three exists and is refused "not linked" only when none does. Any bill status (draft, cancelled,
     soft-deleted too). Removing any COUNTED tie (link, line or header reference of a billed live bill) reopens a PO closed by billing
     (`closed_by_billing`: a link call or migration 1022) once it is no longer fully billed (PR #1703 R3-3 / R4-1 / r4 L2). The audit row says what was cleared (`link_removed`,
     `lines_cleared`, `header_cleared`, `bill_status`, `match_state`, `raised_committed`), and the BILL gets its own audit row
     (entity supplier_invoice) naming what was cleared on it. No ledger effect: these are references only. Budget: clearing a line reference RAISES committed spend
     exactly when `budgets/remainingCommitted.billedLinesByPoItem` counted that line today (the bill is approved / paid / partially_paid,
     the line posts a non-zero ex-VAT amount, and the bill is not soft-deleted: PR #1703 R4-2), so unlink is
     gated and warns like any unlink then; clearing a header, or a draft / cancelled / R0 bill's reference, changes no figure and warns
     nothing. The bill's stored three-way state (`match_status`, each line's
     `line_match_status` and variances) is re-judged by the existing recompute (`performThreeWayMatch`, in its own savepoint) when
     the bill still names a PO, and reset to unmatched when it names none (never left stale).
   - **Seeing the ties.** The refusal NAMES the tying bills (number, id, kind link | line | header; ten shown, the rest counted), and
     `get_purchase_order` `bills[]` lists every tying bill with its `tie` kind (a link on a soft-deleted bill is listed, `deleted:
     true`; capped at 30 with `bills_total`). `list_supplier_invoices` / `get_supplier_invoice` expose the header
     `purchase_order_id` beside `purchase_order_ids` (link rows). One module, `ap/purchaseOrderTies`, feeds both. The supplier-change
     refusal (`poSupplierChangeBlocked`) and the app's approved-PO cancel use the same single wording and name exactly the LINK rows
     they refuse on (they guard on link rows only). The tie list is driven from the PO (its po_items through `idx_sii_po_item`, its
     header references through `idx_si_po`, its link rows by key), so its cost follows the PO's own bills, not the company's. The lock order is unchanged (gate -> PO row ->
     bill rows). Because unlink clears them, cancelled and draft bills' lines count as ties again (the PO's lines are not replaced
     under a line that names them).
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
   directly). **Leaving closed clears `closed_by_billing`** (1016's trigger, whoever writes the status; before PR #1703 R4-1 the
   record was on the links), so a later unlink cannot reopen a PO someone deliberately reopened and closed again (review M3; the
   4-step case is tested). -> approved runs the budget check
   NORMALLY (the import's `skip_budget_check_for_import` does not apply: a status fix is not a load) and stamps
   `approved_by` / `approved_at`; -> closed records `closed_from_status` (always `approved`) as `close_purchase_order` does; leaving
   closed clears it.
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

- **Deleted approved bills still net committed (pre-existing, flagged to Hein, not changed here).** `billedLinesByPoItem` has no
  `deleted_at` filter and a soft delete leaves the status approved, so a deleted approved bill's lines still net a PO line's committed
  spend and per-line `amount_billed`, while `quantity_billed` and `billed_total` exclude it. Unlink therefore warns when it clears such
  a bill's line, because committed does rise. Fixing the predicate changes production budget figures and is Hein's call.

- Short-closing a partially_received / received PO drops goods received and not yet billed from committed spend (committed counts
  open PO lines only); a bill for them can still be created: bill lines naming a line of a CLOSED PO are accepted
  (`assertBillPoLinks` takes `LINKABLE_PO_STATUSES`, as the link tool does), but, closed POs committing nothing, they net nothing.
- An approved PO's update checks the budget after the write (inside the savepoint) where the Approve action checks before it;
  the outcome is the same, a refusal leaves nothing.
- Remaining quantity on close is ordered less received; bills are not netted (a bill line links to a PO line, receipts do not).
