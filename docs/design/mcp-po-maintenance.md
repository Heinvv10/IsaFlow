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
   - Statuses: **draft, submitted and approved.** The app's PUT edits draft and submitted, so those two are parity; approved is
     new (the PUT refuses it and no app action edits an approved PO). partially_received / received / closed / cancelled are
     refused with the status.
   - Lines: as `bulk_create_purchase_orders` (`description`, `quantity`, `unit_price`, `tax_rate`, source `line_total` /
     `tax_amount`, `gl_account_id`, `cc1` / `cc2` / `bu` as code / alias / UUID) plus `item_id` or `item_code` (migration 1005:
     a line naming an item and no account takes the item's purchases account and, with no rate, the item's VAT type;
     `purchaseOrderItemLines`). Priced in cents by the import's rules (`purchaseOrderImportAmounts`); totals are the sums;
     `expected_totals` must equal them to the cent. A line with no `cc1` / `cc2` / `bu` has none (replace, not keep).
     NOTE: in this base `bulk_create_purchase_orders` does not itself accept `item_id` / `item_code` (its line keys refuse them);
     only the update does. Adding them to the import is a small follow-up (one decision: `po_items.item_id` is written by
     `purchaseOrderLinesWrite`, which both writers now share).
   - **Refused when the PO has any goods receipt, or any bill link** (a `purchase_order_bill_links` row, a bill line naming one of
     its lines by `po_item_id` - no FK holds that column - or a bill whose header names it): replacing lines would orphan them.
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
2. **`cancel_purchase_order`** - `reason` required (audited). Draft / submitted: cancelled as the PUT does (any writer), now
   audited and row-locked. Approved: `cancelApprovedPurchaseOrder` (**owner / admin only**, `PO_CANCEL_ROLES`; refuses with a
   receipt and, since #1627, with bill links - "unlink first"). partially_received / received / closed / cancelled: refused
   with the status.
3. **`close_purchase_order`** (short close) - approved / partially_received / received -> `closed`, `reason` required,
   **owner / admin only** (closing releases commitment; Hein's R1 for link-close). Records the status it came from in the new
   column `purchase_orders.closed_from_status` (migration **1007**, below) so a later reopen can restore it. Audit row:
   `status_before`, received and billed ex-VAT amounts at that moment, the reason. The reply lists, per line that was
   short-closed, the ordered-not-received quantity and ex-VAT amount. Bills and links stay.
4. **`set_purchase_order_status`** - for IMPORTED POs: target `draft | approved | closed | cancelled`, `reason` required,
   **owner / admin only**, audited (old -> new). Refused unless the PO carries `external_ref`, when it has a goods receipt, and
   for a move that would orphan bill links (-> draft or -> cancelled while links exist). -> approved runs the budget check
   NORMALLY (the import's `skip_budget_check_for_import` does not apply: a status fix is not a load) and stamps
   `approved_by` / `approved_at`; -> closed records `closed_from_status` as `close_purchase_order` does; leaving closed clears it.
   partially_received / received are never targets (they come from receipts) and refused as sources.
5. **`bulk_create_purchase_orders` changes:**
   - `dry_run` reports per PO `budget_check` (`outcome` ok | warn | block, `policy`, `reasons`; null for a PO that is not
     imported approved) decided by the same check the live call runs, and the existing `dimension_warnings` per PO. A PO the live
     call would refuse on a block no longer fails the dry run: it comes back `would_succeed: false` with the blocked POs listed.
     (The live call still refuses the whole batch.)
   - New `skip_budget_check_for_import` (**owner / admin only**, refused for anyone else before any read, dry run too): an
     approved PO skips the BLOCK. The check is still evaluated, so each approved PO reports `budget_check_skipped: true` and
     `would_have_failed` with the reasons, live and dry run alike; the PO's create audit row (one per PO) carries
     `budget_check_skipped` / `would_have_failed` / the reasons. No budget event row is written for the skipped block (the
     event table has no "skipped" outcome and no migration was added for it).

## Migration 1007: `purchase_orders.closed_from_status`

`TEXT NULL`, CHECK in (draft, submitted, approved, partially_received, received, cancelled). No existing column fits: the link
table's `closed_po_from_status` belongs to a link and a short-closed PO may have none. Written by close / set status (-> closed),
cleared when the PO leaves closed (set status; the unlink's reopen). The old colour never writes or reads it, and `SELECT po.*`
readers pass it through. `get_purchase_order` shows it. 1007 was free on every branch, worktree and open PR on 19 Nov (1008
is `feat/invoice-line-vat-schema-readers-20261119`).

## Lock-order census (extends #1627's)

| Writer | Order |
|---|---|
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

- An approved PO's update checks the budget after the write (inside the savepoint) where the Approve action checks before it;
  the outcome is the same, a refusal leaves nothing.
- A bill header naming the PO counts as a link for the update guard even when the bill is a draft that was never linked.
- Remaining quantity on close is ordered less received; bills are not netted (a bill line links to a PO line, receipts do not).
