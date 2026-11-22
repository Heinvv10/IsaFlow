# MCP purchase-order reports (section 5)

Status: design, 2026-11-21. Builds on sections 2 to 4 (#1627, #1665, #1697) and on #1703, the header-link netting in `remainingCommitted`. Building starts once #1703 is merged, so every figure here reads the engine as #1703 leaves it.

## Tools

| Tool | Kind | Scope |
|---|---|---|
| `committed_spend` | read | read:reports (the same as `budget_remaining`) |
| `po_status_report` | read | read:invoices (the same as `get_purchase_order`) |

Neither tool adds a scope, so no connector has to re-consent. `token_info` did not list tools; it now does: a `tools` field maps each scope the token holds to the names of the tools that scope opens (`tools_without_scope`: the ones any token opens), derived from the registry's own `scope` metadata with no hand list. A write tool that also needs another scope is listed under its own and names the other when it refuses. A census test proves every registered tool appears exactly once, under its scope, and that `read:reports` lists `committed_spend` and not `po_status_report`, and `read:invoices` the reverse.

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

`po_status_report(status?, supplier_id?, from?, to?, older_than_days?, only_outstanding?, limit?, offset?)`

Per PO it gives:

- **ordered:** the PO's billing basis, `remainingCommitted.poBillingBasisCents`: the larger of the header subtotal and the ex-VAT sum of its lines. It is the basis `get_purchase_order`'s `outstanding_to_bill` and #1703's fully-billed rule measure against, so a PO whose header subtotal exceeds its lines, or one with no lines, reads the same in both tools.
- **received:** the value received, as Σ over lines of min(received qty, ordered qty) × unit price. Only live goods received notes count; cancelled ones are already reversed.
- **billed:** the attributed billed amount from #1703's one helper (lines first, then the link, then the capped header fallback), so it is the same figure `fully_billed` and committed use.
- **outstanding:** `ordered - billed`, floored at 0.
- **committed:** the PO's committed value from the same engine. This is 0 for a PO that is not committing.
- **age_days:** today minus `order_date`, where today is the database's Johannesburg calendar day, read in the request's own transaction and returned as `as_of`. It also gives `days_since_last_receipt` and `days_since_last_bill`.
- **linked bills:** up to 10, each with number, status, attributed amount and date, plus `bills_total`; `attributed_via` says how the bill holds the PO (lines, link or header, the attribution's own rule). A soft-deleted or cancelled bill is never listed or counted. A bill not yet approved (a draft) is listed with `counts_as_billed: false`.
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
