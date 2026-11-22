# MCP purchase-order reports (section 5)

Status: design, 2026-11-21. Builds on sections 2 to 4 (#1627, #1665, #1697) and on #1703, the header-link netting in `remainingCommitted`. Building starts once #1703 is merged, so every figure here reads the engine as #1703 leaves it.

## Tools

| Tool | Kind | Scope |
|---|---|---|
| `committed_spend` | read | read:reports (the same as `budget_remaining`) |
| `po_status_report` | read | read:invoices (the same as `get_purchase_order`) |

Neither tool adds a scope, so no connector has to re-consent. `token_info` did not list tools; it now does: a `tools` field maps each scope the token holds to the names of the tools that scope opens (`tools_without_scope`: the ones any token opens), derived from the registry's own `scope` metadata with no hand list. Only what this token AND role can call is listed: the registry's own fences (scope, `write:post`, `requiresScope`, the role fence) decide it through one shared rule (`toolAccess.accessRefusal`, which `McpRegistry.call` also uses), plus a tool's declared `admits` predicate where its handler gates a role itself (`budget_remaining`, `committed_spend`, `derive_three_way`, the audit snapshots, the owner / admin deletes and PO closes, the budget approvals). A viewer with `read:reports` therefore does not see `committed_spend`; a manager does. A tool gated only for one option (an owner-only flag) is listed to anyone the fences admit. A tool that accepts any of several scopes (`list_items`: `read:items`, or `read:reports` for one more release) declares `anyOfScopes`: the registry refuses a token with none of them, and it is listed under each it holds.
  - **Named limit:** `find_by_external_ref` declares no scope and its handler refuses by kind (a different scope per kind), so `token_info` lists it under `tools_without_scope` even for a token that holds none of its per-kind scopes. A registry-level refusal would change the text it returns per kind, so its access rule is left as it is. A census test proves an owner holding every scope sees every registered tool exactly once, under its scope; a second test proves the listing equals what the registry lets through, for every tool and four roles; and that `read:reports` lists `committed_spend` and not `po_status_report`, and `read:invoices` the reverse.

## committed_spend

`committed_spend(from_month, to_month, group_by?: ['supplier'|'cc2'|'account'|'cc1'|'bu'|'month'], supplier_id?, account?, cc2?, limit?, offset?)`

- **What it counts:** the open committed value of purchase orders. That is ordered less billed, per PO line, floored at 0, for the POs that commit spend: approved, partially_received, received, and closed with `closed_by_billing`, in the order-date months from `from_month` to `to_month`, at most 12 months. It is taken from `readCommitments` and the core's per-line open amount (`openPoLineCents`), and nothing is recomputed. So it nets bills exactly as `remainingCommitted` does, including #1703's header links and largest-remainder share of negatives.
- **Grouping:** rows are summed per group key. The default is supplier, then cc2, then account. Each row carries the key's ids and names, `committed` as decimal text, `po_lines` and `pos`.
- **Totals:** a `total` row over every group, plus the unpaged total.
- **The invariant, tested to the cent:** for any (account, month, slice), the sum of `committed_spend` rows grouped by account + month + the account's budget-level dimensions equals the `committed` figure `budget_remaining` returns for the same key.
  - **Lines with no account:** an account-less PO line cannot meet a budget, so `budget_remaining` never sees it. `committed_spend` reports it in a separate `no_account` group, and the invariant covers only lines that have an account.
  - **Off-slice lines:** lines whose dimensions do not match the account's budget level are reported under their own dimensions. The invariant test maps them to the level the same way `budget_remaining` does.
- **`no_account` block:** `no_account: {committed, po_lines, pos}` beside `rows` and `total`, decimal text and counts. It is never inside `rows` or `total`, and an `account` filter leaves it at zero (a filter on an account cannot match a line with none).
- Read-only; owners, admins and managers only, the same as `budget_remaining`, and on the same per-user rate limit (the `budget_remaining` bucket, 120 a minute).

## po_status_report

`po_status_report(status?, supplier_id?, from?, to?, older_than_days?, only_outstanding?, limit?, offset?)`. `only_outstanding` means still to bill on a live order: approved, partially_received and received POs with `outstanding` above 0 (a closed, cancelled or draft PO is left out, though its `outstanding` field still reads as `get_purchase_order`'s does). `total` is the filter's true count whatever the offset.

Per PO it gives:

- **ordered:** the PO's billing basis, `remainingCommitted.poBillingBasisCents`: the larger of the header subtotal and the ex-VAT sum of its lines. It is the basis `get_purchase_order`'s `outstanding_to_bill` and #1703's fully-billed rule measure against, so a PO whose header subtotal exceeds its lines, or one with no lines, reads the same in both tools.
- **received:** the value received, per line `round(line_total × min(received qty, ordered qty) / ordered qty)` in cents, so a fully received line is exactly its `line_total` (qty × unit price can round a cent above it) and a partial receipt is pro rata. `po_items.quantity_received` is what a note adds and a cancel takes back, so a cancelled note is already out of it. `last_receipt_date` counts the notes that hold goods (status received, inspected or accepted, the statuses the goods-received service writes and moves them to), never a draft, rejected or cancelled one.
- **billed:** the attributed billed amount from #1703's one helper (lines first, then the link, then the capped header fallback), so it is the same figure `fully_billed` and committed use.
- **outstanding:** `ordered - billed`, floored at 0.
- **committed:** the PO's committed value from the same engine (`poCommittedCents`). This is 0 for a PO that is not committing. It counts lines with no account, which `committed_spend` reports under `no_account` and `budget_remaining` never sees. It is shown to owners, admins and managers only, as `budget_remaining`'s committed is: any other role gets `committed: null` and a `committed_hidden` reason on each row, and the rest of the report whole.
- **age_days:** today minus `order_date`, where today is the database's Johannesburg calendar day, read in the request's own transaction and returned as `as_of`. It also gives `days_since_last_receipt` and `days_since_last_bill`.
- **linked bills:** the 10 newest (invoice date, then id, both descending), each with number, status, attributed amount and date, plus `bills_total` over all of them; `attributed_via` says how the bill holds the PO (lines, link or header, the attribution's own rule). A soft-deleted or cancelled bill is never listed or counted. A bill not yet approved (a draft) is listed with `counts_as_billed: false`.
  - **Named limit:** a bill that names the PO only in its header is listed whenever the attribution holds it (the PO's supplier), including where the link tool could not link the pair; `get_purchase_order` lists only a header tie the link tool could link, so the two lists can differ for such a bill. `attributed_via` is the attribution's classification and can read `lines` where `get_purchase_order`'s `tie` reads `link`, because that tool lets a link row win over lines.
- **status and closing:** status, `closed_from_status` and `closed_by_billing`.

Ordering is by age, oldest first, then by PO number. Page size is bounded so that a full page stays under `MAX_READ_RESULT_BYTES`, checked by a worst-case test. Every query is company-scoped, and po_items, grn_items and links are reached through the company's PO.

## Tests (integration, app_user)

1. `committed_spend` equals `budget_remaining` committed to the cent across mixed cases:
   - partial bills on lines;
   - a header-only bill (#1703);
   - a negative bill line;
   - a PO closed by billing and then under-billed;
   - a cancelled PO;
   - a manual short-close;
   - two POs on one account and month in different cc2.
2. `group_by` totals add up to the ungrouped total, and the account-less group is reported separately.
3. `po_status_report` matches `get_purchase_order` on billed and received for the same POs. Ages and outstanding are correct; a cancelled goods received note is not counted as received.
4. Another company's POs never appear, including for a user who belongs to both companies.
5. Paging and the byte bound hold on the worst case.
6. Both tools are in the registry and the census, and `token_info` lists them.
