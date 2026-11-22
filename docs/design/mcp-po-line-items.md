# MCP PO import: link a line to its catalogue item

Goal (orchestrator-approved, 2026-11-22): each line of `bulk_create_purchase_orders` may carry `item_id` OR `item_code`, so a
Sage-imported PO line links to its imported item (`items`, `list_items`). `update_purchase_order` already accepts both
(`docs/design/mcp-po-maintenance.md`); the import refused them as unknown fields.

## Behaviour

- A line may send `item_id` (UUID) or `item_code` (text, at most 100), never both (`lines[i]: give item_id or item_code, not both`;
  the wording of `update_purchase_order`). Neither: a free-text line, unchanged.
- The id is stored on `po_items.item_id` (column from migration 1005, already written by `insertPoLines`). **No migration.**
- Resolution is company-scoped (`items.company_id`, `deleted_at IS NULL`), read in the tool's prepare step, before the first write,
  on the dry run too (same code path: `wroteNothing`, parity). First refusal wins and names the element and the line:
  - `purchase_orders[p].lines[i].item_id is not an item of your company`: unknown id, deleted item, or ANOTHER company's item
    (the same text, so no cross-tenant disclosure);
  - `purchase_orders[p].lines[i].item_code: no item with the code "X" in this company`: unknown code, or another company's code;
  - `purchase_orders[p].lines[i].item_id is an inactive item` (a code naming an inactive item says the same);
  - malformed (`item_id` not a UUID, `item_code` not a string / too long): refused at parse.
- The batch stays all or nothing: one refused line refuses the batch and nothing is written.
- Idempotency: unchanged. Arguments are validated before the `external_ref` replay, so a re-run naming an item that has since been
  deactivated is refused rather than replayed. A replay never changes a stored PO, but never drops a link silently either: a line
  that names an item the stored line (same position) does not carry, or carries differently, is listed in `differences` as
  `lines[i].item_id` (existing vs requested) with `payload_differs: true`. A line naming no item is never compared. A re-sent
  `po_number` of another PO is refused as before (only `external_ref` replays).
- The first offending line, in line order, is the one named, whether it names its item by id or by code.

## Decision made here (flag if wrong)

The import **links only**. It does not derive anything from the item. `update_purchase_order` defaults a line's account (the
item's purchases account) and VAT rate (the item's VAT type) when the line sends none. A Sage import sends the source's own
account, rate and amounts, which are stored as sent, and the amounts are priced at parse time, before any item is read. Deriving
here would change which lines the budget check and the account-less rule see, and let an item silently re-price a Sage line.
A line with an item and no `gl_account_id` is therefore still "No budget", exactly as without an item. If the owner wants
item defaults on import it is a follow-up (price after resolution, as `purchaseOrderUpdatePrepare` does).

## Code

- `purchaseOrderImportArgs.ts`: `item_id` / `item_code` join `LINE_KEYS`; `ParsedPoLine.itemId` / `itemCode`.
- `purchaseOrderImportItems.ts` (new): `resolveLineItems(companyId, batch)` returns the lines' item ids or the refusal text.
  Reuses `itemIdsByCode`. Called from `purchaseOrderImportPrepare.ts`; the id reaches `PoLineRow.itemId`.
- `writeBulkPurchaseOrders.ts`: line schema and tool description.
- `update_purchase_order` is untouched.

## Tests

Unit: arg parsing (both given, malformed, shapes). Integration (disposable PG16, as app_user): link by id and by code, free-text
line unchanged, unknown id / code, another company's id and code (text identical to unknown), inactive, both given, row index,
all-or-nothing, dry-run parity (same refusals, writes nothing), replay. Mutants: drop `company_id` from the item lookups, drop
the inactive guard, drop the both-given guard.
