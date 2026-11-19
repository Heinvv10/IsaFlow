# MCP: purchase order <-> bill links (section 2 of the 19 Nov PO brief)

Why: Velocity's Sage data carries 827 bill->PO links (`FromDocument`) on 628 POs; 813 resolve to IsaFlow bill ids. They
must load right after the 757 POs (#1591) without reposting a single bill. Section 1 (items) is PR #1604, another
session; sections 4, 3, 5 follow this PR.

Status: built (migration `1006`, tools `link_bills_to_purchase_order`, `unlink_bill_from_purchase_order`,
`get_purchase_order`). This note is kept in step with the code; the review rounds of 19 Nov changed decisions 4, 6, 8, 9,
10, 11 and added 14-17, the lock-order census and the known limits. Round 2 changed the PO lock mode, the app sync (a diff), the
backfill's population, the unlink's budget reading and PO cancel (decisions 10, 11, 13, 14, the census).

## What exists

- `supplier_invoices.purchase_order_id` - ONE PO per bill, no FK (older rows may name `supplier_purchase_orders`).
- `supplier_invoice_items.po_item_id` - a bill line's PO line. Budget committed (`budgets/remainingCommitted`) nets a
  PO line by the posted ex-VAT of every linked bill line on an approved / paid / partially_paid bill; the three-way
  match (`ap/threeWayMatchState`) judges each line against its PO line and GRN line.
- Before this work only the REST create wrote either column (`ap/supplierInvoicePoLinks.assertBillPoLinks`).

## Decisions

1. **New table `purchase_order_bill_links`** (migration `1006`): one row per (company, PO, bill). Columns: `id`,
   `company_id`, `purchase_order_id` (FK purchase_orders), `supplier_invoice_id` (FK supplier_invoices), `amount`
   NUMERIC(19,2) NOT NULL > 0 (ex-VAT billed against this PO), `source` (`mcp` | `app` | `backfill`), `external_system`
   (lower case), `external_ref`, `closed_po_from_status` (the status a link call closed the PO from), `created_by`,
   `created_at` (`clock_timestamp()`, so one call's links keep their order). UNIQUE (company_id, purchase_order_id,
   supplier_invoice_id); UNIQUE (company_id, external_system, external_ref) where a ref is present. RLS on company_id like
   the other tenant tables. A bill may link several POs (Sage does).
2. **Line links reuse `supplier_invoice_items.po_item_id`.** That way committed, the three-way match and the bill page
   pick them up with no new reader. One bill line -> one PO line, whole line (no splitting a bill line across PO lines:
   the brief's per-link qty/amount is the bill line's own). A bill line already naming ANOTHER PO line is refused; naming
   the same one is fine.
3. **Header column kept in step, where it is ours to rewrite.** `supplier_invoices.purchase_order_id` = the bill's PO
   when it has exactly one link, else NULL, but only when the header is NULL, names a PO this bill has a link row to, or
   names the PO an unlink just removed (`purchaseOrderBillLinkHeader`). A header naming anything else (an older
   `supplier_purchase_orders` id, a canonical PO with no link row) is the caller's data and is never rewritten. The
   three-way read takes PO lines from the header PO AND the lines' own `po_item_id`, so a multi-PO bill still matches.
4. **Link amount** (stored, so a bill's split never changes later). One rule, in TypeScript (`recordBillLinks`,
   `planBillLinks`, the MCP planner) and in SQL (`po_bill_posted_cents` + the backfill), proved equal to the cent by
   `mcp-po-bill-links-amounts.int.test.ts` on fixtures and 120 random bills:
   - the explicit `amount` (MCP only); else
   - the POSTED ex-VAT of the bill lines linked to this PO, when that is above zero. "Posted" is what APPROVE posts for a
     line (`ap/supplierInvoiceExpenseLines.expenseLineNets` via `budgets/remainingCommitted.postedExpenseLines`): a bill
     stored gross is scaled to its subtotal, the last line takes the rounding residual, a R0 line posts nothing. Never the
     raw `line_total`; else
   - the bill's ex-VAT subtotal less what its other links hold (a PO the bill names only by its header, or whose lines
     post nothing). In the app writer the "other links" include any `mcp` or adopted link the bill already has, so a bill's links
     never pass its subtotal; a line amount is never more than the subtotal (a negative last line can make the lines' sum
     larger). Of several such POs in the app writer / backfill only the lowest id (byte order of its text) is linked.
   Refused (MCP) when it would be <= 0 or take a bill's links past its subtotal (+1c); the app writer links nothing then.
5. **Billed** for a PO = sum of link amounts on bills in approved / paid / partially_paid (`BILLED_STATUSES`), not
   deleted. Per PO line: billed qty and amount from linked bill lines (`billedLinesByPoItem`, the same posted amounts
   committed uses). Computed on read; nothing is rolled up into `po_items`, so there is nothing to drift.
6. **Fully billed** = billed >= PO subtotal - 1c (Hein, 19 Nov). Status is left alone unless the call passes
   `close_when_fully_billed: true`, which **requires owner or admin** (`PO_CANCEL_ROLES`, Hein R1, 19 Nov; a manager's
   call with the flag is refused before anything is read, dry run too). Then an approved / partially_received / received
   PO that the call leaves fully billed moves to `closed`, and the LAST new link of that PO in the call records the status
   it came from (`closed_po_from_status`). Every response reports `fully_billed`.
7. **No ledger effect.** Linking never touches `gl_journal_*`, bill status, amounts or `amount_paid`. Tested with bills
   that really carry journals.
8. **Allowed:** PO approved / partially_received / received / closed (the Sage Invoiced POs import as closed);
   refused: draft, submitted, cancelled. Bill (MCP, Hein R3, 19 Nov): approved / paid / partially_paid only; a draft,
   pending, disputed, cancelled or deleted bill is refused with its status. Same company, same supplier (cross-supplier
   refused). The app writer and the backfill link a PO of the bill's supplier in a linkable status, whatever the bill's
   status (a draft bill the app is saving has an `app` link).
9. **Idempotency and adoption:** a pair already linked under the same (external_system, external_ref) -> `already_existed`
   when the amount (if sent) and the lines (if sent) agree, else refused `payload_differs`. A pair linked WITHOUT a
   reference (made by the app or the backfill) re-sent with an `external_ref` ADOPTS it (`adopted_reference`, audited) under
   the same test (a Sage load over app-linked bills); the link's amount, source and creator do not change. A pair linked
   otherwise -> refused ("already linked"). An external_ref used on another pair -> refused. A reference, once set, never
   changes (database guard).
10. **Unlink** (`unlink_bill_from_purchase_order`, one pair, reason required, audited; widened by PO maintenance round 5 to be the ONE exit for every tie, `mcp-po-maintenance.md`: it also succeeds on a line-only or header-only reference with no link row and clears them, and refuses "not linked" only when none exists): deletes the link, clears `po_item_id`
    on that bill's lines that point into this PO, resets the header (decision 3), then decides the PO's status (Hein R1): if
    the PO is closed, a link of it records a closing (`closed_po_from_status`, read BEFORE the delete: it may be the deleted
    link's) and the PO is no longer fully billed after the unlink, it reopens to that status and the record is cleared; if it
    is still fully billed and the deleted link held the record, the record moves to another link of the PO on a BILLED bill
    (durable `mcp` / referenced links first; never a draft's app link, which the draft's next edit remakes); a PO closed by
    hand, or cancelled, is not touched. A bill CANCELLED after the close does NOT reopen the PO: `get_purchase_order` says
    `closed_under_billed: true` (closed by a link and billed < subtotal - 1c) and a person decides. **Budget (Hein R2):** an
    unlink takes the budget gate first (as approve does) and never blocks; when the PO commits spend again (it reopened, or its
    lines are un-netted) the PO approve's budget check runs in warn form (`checkPurchaseOrderBudget`, channel mcp) and an
    over-budget result comes back as `budget_warning` / `budget_warnings`, whatever the policy. The check is a READ
    (`previewPurchaseOrderBudget`, the lines the Approve dialog judges): it records no `budget_check_events` row and no `approve`
    audit row, and words the result as the unlink's ("Unlinked. Purchase order PO7 commits spend again and is now over budget on
    ... by R..."), never as an approval refusal. A busy gate (`BudgetCheckLockTimeoutError`, caught in its own savepoint) or a
    policy that changed never fails the unlink: the reply says the budget could not be checked. Reopening by unlink stays open to any
    `write:invoices` holder (Hein, 19 Nov): it restores a commitment, the conservative direction (closing is the owner's / admin's
    call; undoing it is not). A legacy header that names a PO this bill has no link to stays after an unlink (decision 3).
    **PO cancel** (`cancelApprovedPurchaseOrder`) is refused while any bill is linked to the PO ("unlink first"; brief section 4).
11. **Backfill + app writer:** the migration (`purchase_order_bill_links_backfill([company])`, all companies when none is given) inserts a `backfill` link for every
    non-cancelled, not-deleted bill of any other status (round 3: approving a bill writes no link, so a bill that was a draft at the
    release, or that the old colour created, would otherwise never get one; the app sync owns ref-less `app` / `backfill` links of
    an unposted bill and remakes them on its next edit, so a draft's link cannot stay stale), per PO that the header names OR the lines name (line-only bills too), of the same company and supplier, PO in a
    linkable status, amount per decision 4 (a header-only / zero-posting PO gets the subtotal less the bill's links this writer does
    not own, as the sync does, so a re-run never pushes a bill's links past its subtotal). The backfill never aborts on a row that changes while it runs (round 4: the table's guard reads with a fresh statement snapshot, so a PO deleted after the backfill chose its row used to raise the guard's error and abort the whole call; each row is now inserted in its own sub-transaction and a refused one is skipped with a WARNING). The plan has no bills x POs shape, whatever the statistics (round 4 + round 5; reviewers measured the first query at 40 000 bills / one supplier: 40 s on one box and over 300 s on another under load, while the FKs hold SHARE ROW EXCLUSIVE, so it would pass `statement_timeout`; the round-4 rewrite still went quadratic on ~35% of parallel test runs: it joined the bill lines, a CTE without statistics, to `purchase_orders` ON company AND supplier, estimated at 41 rows, 982 167 in fact for 1 300 bills x 400 POs). Every join is on a key: a bill to its lines' posted cents (`po_bill_posted_cents`, once per bill, `ROWS 3`), a line to its `po_items` row, that row to its PO, a bill to its header PO, all by id (`pairs`, materialized). The bill's company / supplier and the PO's status are compared only after that, as a filter on one row, never as a join clause; a header PO that a line also names folds into the line's pair by `GROUP BY` (no `NOT IN` / anti join against a CTE), and nothing joins after `pairs`. Its output is the round-4 query's, row for row (EXCEPT ALL both ways on 9 random seeds: one supplier with 400 POs and 1 500 bills beside small ones, header-only / line-only / mixed bills, held `mcp` and referenced links, drafts, cancelled and deleted bills, POs in every status, cross-supplier and cross-company headers and lines). Measured as `postgres` (not a superuser) on a throwaway PG16 at load average ~65: 40 000 bills x 5 000 POs of one supplier 5.4 s, 150 000 bills over 30 companies (15 000 POs) 18.5 s, inserts included. Two tests guard it (`po_bill_posted_cents` calls <= bills; EXPLAIN ANALYZE of the live function's query under default, nested-loops-only and no-nested-loops planning, no join putting out more than 4 x its larger input, no node run once per row of another handling more than 4 x (bills + POs) rows in all; neither reads other suites' row counts: red on the round-4 query every run, a Materialize run 600 times for 540 000 rows), and the call `RAISE NOTICE`s its written / skipped counts for the release log. **Run `SELECT purchase_order_bill_links_backfill();` once more as the deploy role
    (`postgres`, which bypasses row security) after the release is live:** a bill the old colour approved between the migration and
    the switch has no link until then; the function is idempotent. The REST / MCP bill create inserts `source = 'app'` links by the
    same rule INSIDE the create's transaction (`recordBillLinks`), and every draft edit (REST PUT, MCP `update_supplier_invoice`)
    syncs them (`refreshAppBillLinks`, the same function): a DIFF against the links this writer owns (`app` / `backfill`, no
    external reference): a link that is already right is not touched (no lock, same `created_at`), a stale one is deleted and made
    again (a closing record on it is carried over, only while the PO is closed), an owned link of a PO the bill no longer names goes (its record
    moves to a link on a billed bill); `mcp` and adopted links are not touched and count against the
    subtotal. A supplier change on a bill that has links is refused (the MCP draft edit; the REST PUT
    takes no supplier), and on a PO that has links (the PO PUT); supplier merge is refused while the source supplier's POs
    have links (the smaller safe option; re-parenting both sides would need the merge to move links atomically).
12. **Scope `write:invoices`** (as `bulk_create_purchase_orders`): a new scope would need every connector re-consented
    before the migration can run.
13. **Locks:** see the lock-order census below. The PO is taken `FOR NO KEY UPDATE` by link and unlink (round 2, M1): it still
    excludes another link / unlink and PO cancel / approve / goods receipt (`FOR UPDATE`), but not the `KEY SHARE` a draft edit's
    link insert takes on the PO through the FK, which a draft edit holding its bill would otherwise wait on while the link call
    waits for that bill (a reproduced 40P01). The app writer reads the PO `FOR KEY SHARE` (the lock its insert takes anyway): it
    waits for a concurrent cancel and then re-reads the status, so a PO cancelled meanwhile gets no link.
14. **Database guards** (`1006`): `purchase_order_bill_links_guard` (BEFORE INSERT OR UPDATE): PO and bill are the row's
    company's and one supplier; `source = 'backfill'` only from a role that is not app_user / app_service; the closing record
    only while the PO is closed, moved or cleared never rewritten; a reference never changes once set; nothing but the
    reference and the closing record updates (column grants: UPDATE on those three columns only). `...supplier_guard`
    (BEFORE UPDATE OF supplier_id on purchase_orders and supplier_invoices): a linked PO or bill cannot change supplier, so
    a link can never become cross-supplier. The supplier guard is SECURITY DEFINER (owner migration_admin, pinned
    search_path, registered in `app_definer_reviews`, 930): an invoker would see only the links the caller's row security shows and
    could pass silently for a role that sees none; the other guard stays INVOKER on purpose (a caller is refused a PO or bill it
    cannot see). `source = 'backfill'` only from `postgres` / `migration_admin`. `ENABLE ALWAYS` on all three triggers (tested with
    `session_replication_role = replica`). The definer's read of the table is granted to migration_admin explicitly, and the migration asserts it. Cross-company refusals are enforced twice: by every tool query's company scope and by RLS.
15. **Readers keyed on the header PO** (review finding 4) now read the link table too: the bill list's `has_po`
    (`supplierInvoiceQueryService`), the PO documents auto-linked to a bill's document (`documentStorageService.autoLinkSupplierInvoice`),
    the bill PDF's "PO #" (`supplierInvoicePdfBuilder`: the older family's number, else the linked POs' numbers), the bill page's
    Match action (`useSupplierInvoiceActions`: any line naming a PO line), the three-way read (decision 3). Checked and unchanged:
    `purchase-orders/unmatched.ts` (keyed on `po_items.quantity_invoiced`, not on a bill), `purchaseOrderListService`,
    `reports/purchases-by-item` (PO lines only).
16. **Reading the table:** `find_by_external_ref` kind `po_bill_link` looks up on the (company, external_system, external_ref)
    index (the system is stored lower case; the lookup does not wrap the column in `lower()`).

## Lock-order census

One 5 s deadline (`withRowLockBudget`) covers the row sections of a call; a row held past it is a typed retryable refusal
raised before anything is written. Orders, first lock first:

| Writer | Order |
|---|---|
| `link_bills_to_purchase_order` | external-ref advisory locks (sorted) -> PO rows `FOR NO KEY UPDATE` in id order -> bill rows in ONE id order: the call's bills AND the bills of the existing links of those POs (so billed / fully_billed cannot move under the close decision) |
| `unlink_bill_from_purchase_order` | budget gate (`budget_check:<company>` advisory lock, block policy only; warn / off take none; a busy gate is survived) -> PO row `FOR NO KEY UPDATE` -> bill rows (this bill and the PO's other linked bills, one sorted list) |
| bill approve | budget gate (block) -> bill row |
| bill cancel | bill row |
| PO approve | budget gate (block) -> PO row |
| PO cancel (approved) | PO row `FOR UPDATE` (refuses while links exist) |
| goods receipt | number lock 620 -> PO row -> its `po_items` rows |
| PO import (`bulk_create_purchase_orders`) | budget gate (an approved PO) -> number counter row -> external-ref advisory locks |
| `recordBillLinks` / `refreshAppBillLinks` (bill create, draft edit) | the bill's own row (held by the edit) -> the PO rows it names `FOR KEY SHARE` (id order; ALWAYS taken when the bill names a PO, whether or not a link is then written; also what the link FK takes) -> link inserts / deletes. |
| supplier merge | batches -> payments -> bills -> supplier_purchase_orders (unchanged); refuses first when linked |
| bill create (`createSupplierInvoice`) | the named POs `FOR KEY SHARE` (id order) with the PO lines re-checked under it, before the bill or its lines are written (PO maintenance review M1); the bill row is new |
| `update_purchase_order` (PO maintenance, `mcp-po-maintenance.md`) | account rows `FOR SHARE` (prepare) -> budget gate (an APPROVED PO, block only) -> PO row `FOR UPDATE`; reads links / bill lines, no bill row |
| `cancel_purchase_order` / `close_purchase_order` | PO row `FOR UPDATE` (no gate: releasing a commitment); reads links, no bill row |
| `set_purchase_order_status` | budget gate (-> approved, block only) -> PO row `FOR UPDATE`; no bill row |

No cycle: every writer that takes the budget gate takes it FIRST (the link tool takes none: it never raises committed spend,
closing releases it; the PO maintenance tools above take the PO row and never a bill row, so they cannot meet the bill-row order); the PO is always taken before a bill (link, unlink), and the only writer that holds a bill row and then
touches a PO row is the app writer (a draft edit), whose lock is `KEY SHARE`, compatible with link / unlink's `NO KEY UPDATE`
(it conflicts only with `FOR UPDATE` holders: PO cancel / approve / goods receipt, which take no bill row, so no cycle either);
bill approve / cancel hold no PO row (their budget check reads POs without row locks); goods receipt's number lock
precedes its PO row and the link tool takes neither; the external-ref advisory keys (`external_ref:<company>:po_bill_link:...`)
are taken only by the link tool, always before its PO rows, always sorted. Proven in motion by
`mcp-po-bill-links-races.int.test.ts`: link x unlink x PO cancel x bill approve x bill cancel on the same rows under the
block policy, ten rounds, with a draft edit leg, no 40P01 / 55P03 and a consistent end state; a deterministic draft edit vs
link / unlink case (the reproduced deadlock); opposite-order reference lists; held PO / bill / "another link's bill" rows end in
the typed timeout with nothing written.

## Tools

- `link_bills_to_purchase_order` - `links` <= 200: `{ po_id | po_number, bill_id, amount?, lines?: [{ po_item_id,
  bill_line_id }], external_system?, external_ref? }`, `close_when_fully_billed?` (owner / admin), `dry_run?`,
  `idempotency_key`. All or nothing; every bad row is listed (`links[i]: reason`). One audit row per link (entity
  purchase_order). `dry_run` runs the real service in a rolled-back savepoint (every guard) and leaves the key free; so does
  a call that wrote nothing (every pair already_existed).
- `unlink_bill_from_purchase_order` - `{ po_id | po_number, bill_id, reason, dry_run?, idempotency_key }`; replies
  `reopened_to`, `billed`, `fully_billed`, `budget_warning`.
- `get_purchase_order` (read) - `po_id | po_number`, `offset` (lines): header, lines (ordered / received / billed qty and
  amount, outstanding; 40 per page), every bill that TIES the PO (30; each with `tie`: link | line | header, `deleted`; PO maintenance round 6), GRNs (15, 5 items each with `items_total` / `items_truncated`),
  documents (15), `billed_total`, `outstanding_to_bill`, `fully_billed`, `closed_under_billed`.
- `list_supplier_invoices` / `get_supplier_invoice` gain `purchase_order_ids`; `get_supplier_invoice` gains each line's
  `po_item_id` and `three_way` (status fully_matched / po_matched / grn_matched / unmatched, tolerances and per-line
  variances for the lines that name a PO line, 30 listed with `lines_total`).
- `find_by_external_ref` gains kind `po_bill_link`.

## Known limits

- **A header-only bill on a submitted PO gets no link when the PO is later approved.** The REST bill form lists submitted POs; a bill that names one only in its header gets no link (a submitted PO is not linkable) and approving the PO writes none. The link tool, or the post-release `SELECT purchase_order_bill_links_backfill();` re-run, picks it up. Until then the PO maintenance tools refuse to edit or cancel it ("unlink it first": unlink clears a header reference that has no link row).
- **Backfill timing:** see decision 11: run the backfill function once after the release.
- **Credit notes do not reduce billed.** A supplier credit note against a bill leaves its link amount (and so the PO's
  billed total and `fully_billed`) as it was.
- **A multi-PO bill cannot be `fully_matched` across its POs:** the three-way read takes goods received only from the bill's
  own `grn_id` (one GRN), so a line of the second PO reads no goods received and tops out at `po_matched`.
- **A header-only link (no line links) does not reduce budget committed for a still-open PO;** only line links and closing the
  PO do. Section 5 (`committed_spend`) decides whether committed should net header links too.
- No splitting one bill line across PO lines.
- A bill cancelled after a close leaves the PO closed (`closed_under_billed`); a stale closing record on a link of a PO that a
  person later reopened by hand stays until that link is unlinked.
- The `app` links of a bill are made at create and on each draft edit; a bill edited by a path that does not call
  `refreshAppBillLinks` (none today) would keep a stale amount until the next edit.
- The PDF's "PO #" is not asserted by a test (the text is compressed in the file); the query is exercised by the reads suite.
