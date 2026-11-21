# Intercompany mirror posting — plan (2026-11-17)

Hein, 2026-11-17: Blitz Fibre supplies Velocity Fibre; Brighttech (CrestaHQ) likewise. Today every
intercompany invoice, credit note and loan movement is captured twice by hand. Build mirror posting
for group companies and for external companies that run their own IsaFlow tenant.

## Rulings (grill, 2026-11-17)

1. **Model:** Business Central-style IC inbox/outbox + Intuit "receiver accepts". The sender writes an
   outbox *message*; the receiver's side creates a **draft** document. Nothing ever posts in another
   tenant without the receiver's approval step (auto-accept still creates drafts and runs the receiver's
   normal approve path as the receiver company).
2. **Trade always goes through AR/AP** (tax invoice, VAT, ageing intact). No posting straight to loan.
3. **Settlement mode per connection side:** `cash` | `loan`.
   - `cash`: invoice ages in AR/AP; a payment on one side becomes a *match suggestion* on the other
     side's bank line (never a posting — the receiver's own bank feed brings the cash).
   - `loan` (Velocity ↔ Blitz): approval leaves the invoice in AR/AP. Cash between the two goes to the
     IC loan account. When the payer allocates a payment to invoices, each invoice is **cleared against
     the loan account** (DR AP / CR Loan; mirror DR Loan / CR AR). Loan account = unallocated payments.
4. **Allocation mirrors:** the payer's allocation creates the same clearing on the receiver's paired
   invoices. Group + auto-accept → posts immediately; otherwise inbox item. Unpaired invoice → mismatch
   item, never a guess.
5. **Cut-over date per connection.** Before it: a one-off **pairing screen** links already-open documents
   (suggest by number + amount, confirm, no postings). Unpaired → exceptions list. Opening loan balances
   carry over; the system shows the cross-side difference only.
6. **Loans are running balances.** The loans module is NOT extended. A non-invoice advance is a payment
   to the loan account → mirrored as a loan-movement match suggestion.
7. **Optional interest per connection side** (off by default): month-end, average daily balance of the
   lender's loan account × rate → draft VAT-exempt interest invoice (exempt financial service) on the
   lender, approved by a human, then mirrors like any invoice. Willie confirms rate/tax before enabling.
8. **Group vs external:** both companies active members of the same `company_groups` row = *group*
   (auto-accept allowed). Anything else = *external*: connect by **connection key** (Xero Network-key
   style: private per company, no tenant search/enumeration) → invite → accept; either side revokes.
   Auto-accept is never available for external connections.
9. Edits/rejections never touch the sender's books. Receiver edit → mismatch + "issue a credit note"
   message back. Reject requires a reason, returned to the sender's outbox.
10. Duplicate protection: one message per (from company, source doc type, source doc id, kind) — DB
    unique — plus the normal supplier + invoice-number duplicate check on the receiver.

**RULING 2026-11-21 (Hein):** per-pair cutover. A company pair's cutover is the date from which both
companies of the pair have mirroring switched on: the latest of the connection's cut-over date and the
two sides' `mirroring_since` (set by the database to the start of the next Johannesburg day when a
side's customer and supplier links are both set; cleared when either is removed). A pair has a cutover
only in the group its mirrors go to (the oldest active group with both as members). From that date
the manual P1 generator does not draft a sale-class row of the pair (sale, purchase, mgmt_fee; both
directions) that a mirrored document of that group eliminates: it lists it "eliminated by mirroring".
That answer is a STORED, exclusive link (one mirror accounts for at most one sale row and one purchase
row across every run and period, given to the closest matching row), judged as at the period being
generated: a mirror that stops eliminating the row inside that period releases the link and the row is
drafted; a stop dated after the period is the mirror's own counter-elimination in that later period. A
mirror whose lines are not all mapped to group accounts does not take a row. A row no mirror accounts
for (rejected, pending, not approved, never sent) is drafted with a CHECK BEFORE POSTING note saying
why, so the mirror is the only elimination when one exists and no sale goes uneliminated. A hand-made (`create-elimination`) adjustment
dated on or after a cutover of the group needs a typed reason, enforced by the API and the dialog and
stored (`consolidation_adjustments.manual_reason`); it names no companies, so any cutover of the group
on or before its date counts. Before the cutover nothing changes: a manual row can still overlap a
mirror (a document dated after the cut-over date but approved once both sides were on is mirrored), so
the duplicate flag, the list's badge and the post confirm stay for those rows.

## Existing code we build on (surveyed on origin/master 43f99f41ca)

- `approveCustomerInvoice` (`services/ar/customerInvoiceApprovalService.ts`) — finalise; seals a PDF
  snapshot. Callers: invoice detail route, MCP `writeInvoices.ts`, `writeBulkFinalizeInvoices.ts`,
  recurring runs. The outbox insert goes here, same transaction.
- `createSupplierInvoice` / `approveSupplierInvoice` (`services/ap/`); supplier credit notes via
  `credit_notes.type='supplier'` (`ar/creditNoteService.ts`, `creditNoteApproveService.ts`).
- `contraSettlementService.ts` — settles AR/AP against a non-bank GL account (migration 540). The loan
  clearing is this service; no new settlement engine.
- `intercompany_transactions` / group pages (`pages/accounting/group/intercompany.tsx`) — pairing
  records + eliminations for group connections.
- Cron pattern: `pages/api/cron/*` + `X-Cron-Secret` + `scripts/isaflow-*.timer`. `background_jobs`
  has no consumer — not used.
- No outbox/event hook, no cross-tenant inbox, no customer/supplier → company link exists today.

## Data model (one migration per phase; prefix chosen at implementation time, `IF NOT EXISTS`)

- `intercompany_connections` — id, company_low_id, company_high_id (ordered pair, unique), kind
  (`group`|`external`), status (`pending`|`active`|`revoked`), invited_by_company_id, invited_by,
  accepted_by, revoked_by, timestamps.
- `intercompany_connection_sides` — connection_id, company_id (the owning side; RLS by company_id),
  partner_company_id, customer_id, supplier_id, settlement_mode, loan_account_id,
  default_expense_account_id, default dimensions, auto_accept (CHECK only when kind=group, enforced in
  service + trigger), cutover_date, interest_rate_pct (nullable).
- `company_connection_keys` — company_id, key hash, rotated_at (external connect only).
- `intercompany_messages` — id, connection_id, from_company_id, to_company_id, kind (`invoice`,
  `credit_note`, `payment`, `allocation`, `interest_invoice`, `reject`, `credit_request`),
  source_doc_type, source_doc_id, payload JSONB (sender's snapshot: number, dates, lines, VAT, totals,
  sender VAT number, sealed PDF ref), status (`pending`|`accepted`|`rejected`|`dismissed`|`failed`),
  target_doc_type/id, reason, error, handled_by/at. UNIQUE(from_company_id, source_doc_type,
  source_doc_id, kind). RLS: visible to from- or to-company only; receiver may update status; sender
  may only insert.
- `intercompany_document_links` — connection_id, company_a/doc_a, company_b/doc_b, origin
  (`mirror`|`manual_pairing`). The pair fact used by allocation mirroring and reconciliation.

**Cross-tenant write rule:** the sender's transaction writes only its own outbox row. The receiver's
draft is created either in the receiver's own `withAuth` request (Accept) or by the worker running
`withCompanyContext(receiverCompanyId)` with the receiver's GUCs — never with the sender's. Payload is
the sender's own data only; the sender never reads the receiver's ledger.

## Revised after P1 review (2026-11-17)

These supersede the Data model above wherever they differ (migrations 1000 and 1002 carry them).

- **Pair-level agreement.** `settlement_mode`, `cutover_date` and `interest_rate_pct` live on `intercompany_connections`, not on a
  side: they are one agreement between the two companies. A group connection's change needs a write role in BOTH companies (service and
  DB guard). Per side stay: customer, supplier, loan account, default expense account, default dimensions, `auto_accept`.
  A customer or supplier is linked to one connection per company (partial unique index), which also serves P2's "who is this sender" lookup.
- **Links are the authoritative pair record.** `intercompany_document_links` carries `message_id`, `status`
  (`pending_confirmation` | `active` | `unlinked`), `confirmed_by_a/b`, `confirmed_at`, `unlinked_at/by`. A `mirror` link is made by the receiver
  of an accepted message and joins exactly that message's source and target documents (active at once); a `manual_pairing` is pending until the
  other party confirms (a user with a write role in both companies of a group may confirm both); either party may unlink. Document types are a
  closed list (`customer_invoice`, `supplier_invoice`, `credit_note`). `intercompany_transactions` is written only for GROUP pairs, to feed
  eliminations; the links, not that table, are what allocation mirroring and reconciliation read.
- **Group detection uses `company_groups` only.** Two companies are a group pair when both are current members (`left_date IS NULL`) of one
  `company_groups` row. `company_relationships` is intentionally not used.
- **Membership is checked for the life of a group connection, by registered SECURITY DEFINER helpers.** `intercompany_in_one_group(a, b)` answers
  whatever the caller's RLS shows; it is used on create / re-activate, on message insert and when a side turns auto-accept on. A trigger on
  `company_group_members` revokes a leaving company's active group connections. P2's auto-accept worker re-checks membership through the same
  helper before it writes in the receiver's books, and P6's connection-key lookup will be a registered definer too (the caller must not read
  another company's key row). Every definer is listed in `app_definer_reviews` (migration 930).
- **External connections are not available until P6.** The connections guard refuses `kind = 'external'` on INSERT. Pair uniqueness is a partial
  unique index over non-revoked rows; creating a group connection on a revoked pair re-activates that row (group only).
- **Connection keys** are 32-byte random values, shown once and stored as a SHA-256 hex hash (`company_connection_keys.key_hash`).
- **Messages.** `handled_via` (`user` | `auto`) is set server-side; the payload is at most 256 KiB; a dismissed message can be restored to
  pending; a message is accepted only while its connection is active. For the `allocation` and `payment` kinds `source_doc` is the allocation /
  payment ROW id, so a repeat event is a distinct message. `error` holds a generic sentence for a person, never raw SQL or exception text.

### Round 2 (2026-11-18)

- **Migration.** Round 1 is `1000_intercompany_connections.sql` (master took 999p). Round 2 is a FORWARD migration, `1002_intercompany_round2.sql` (1001 is another open PR's): 1000 may reach prod before round 2 merges, so it is never edited. 1002 adds no column and drops none, replaces function bodies and indexes, is idempotent, and backfills rows 1000 may hold (stale group connections are revoked, revoked connections release their links).
- **A revoked connection releases its customer and supplier links** (registered definer `intercompany_release_links`, trigger on the connection's status), so the per-company unique indexes never hold a customer or supplier on a dead connection; re-activating does not restore them (the checklist shows them undone). The other side settings are kept.
- **Viewers read only.** Every app_user write on the five tables needs `intercompany_user_can_write(<acting company>)` in the table's
  guard: a connection's status (revoke, accept, re-activate), a side, a message's sending or handling, a link's insert, confirmation or
  unlink, a key. P2's auto-accept worker therefore runs with the claims of a write-role user of the RECEIVER (it sets
  `request.jwt.claims` and `app.current_company_id` for that company); there is no user-less write path, by design.
- **A deleted group ends its connections.** `intercompany_in_one_group` and the revoke-on-leave trigger both require `company_groups.is_active`;
  a trigger on `company_groups` (is_active, DELETE) revokes the connections of a group that is deleted (`deleteGroup` clears `is_active`).
  The revocation is stamped `system:group-membership`; the connections guard accepts it only from migration_admin with a transaction-local
  flag set by the definer trigger function (the flag alone is settable by any session, so it proves nothing by itself).
- **`intercompany_in_one_group` is not a membership oracle.** It is false unless the caller is a party (a user of one of the two companies, or
  a session whose company is one of them); the unrestricted check is internal (`intercompany_shared_group`, executable by migration_admin only).
- **Group topology is serialised (closed).** Under READ COMMITTED a check of "do A and B share a group" is stale by the time its writer commits,
  and two memberships changed at the same moment each see the other's change uncommitted (write skew: both leaves pass, no group is left,
  the connection stays active). One lock protocol, documented in 1002's header, on `intercompany_company_locks` (one row per company, closed to
  every app role, a row for every company from the start: backfilled as migration_admin, and made by a trigger on `companies`). DECIDERS
  (`intercompany_in_one_group`: a connection created or re-activated, auto-accept switched on, a message sent) check that the caller is a party,
  read whether the pair shares a group WITHOUT a lock, and only a pair that does takes its two companies' rows FOR SHARE (then reads again).
  JOINERS take ALL the group's members' rows and their own FOR SHARE, so a join cannot commit while a changer holds one of them. CHANGERS are
  STATEMENT-level triggers with transition tables (members and groups, UPDATE and DELETE): one firing sees every row of the statement, so a bulk
  leave, a group deleted with its members and a multi-row update lock ONE set in ONE sub-transaction (a row-level trigger kept the first row's
  locks while a later row waited: a stall of unrelated pairs and a wait cycle no deadlock detector sees). They return early only for a statement
  that changed nothing that can end a connection, and otherwise take the SEEDS (the leavers, or a deactivated group's members), the other party
  of every CANDIDATE (a live group connection of a seed that would no longer share a group) and the group's members that hold a live group
  connection to a seed; a member with no connection to a seed is not locked, so a viewer holding it two hops away cannot veto the change. They
  take the whole set or none (rows `NOWAIT` in a sub-transaction, retrying), re-read under the locks and restart if the set changed, so a
  waiting changer holds nothing and cannot deadlock. The wait is bounded (`app.intercompany_changer_budget_ms`, default 10 s, at most 30 s): then
  the statement fails with SQLSTATE 55P03 ("try again in a moment"), nothing changes, and `withErrorHandler` answers it from any route as a 503
  with `Retry-After` and a neutral message (`removeMember`, `deleteGroup`, `addMember` need no code of their own; the polling is the retry).
  A session can only delay work that involves a company its user belongs to, or a connected company in a group of its company: a stranger, an
  ungrouped pair, a claim-less session and a no-op hold nothing, and since 1002 revokes app_user's table-level UPDATE, DELETE and TRUNCATE on
  `company_group_members` and `company_groups` (column-level UPDATE stays for what the application writes) it cannot `LOCK TABLE` them
  either. The protocol needs READ COMMITTED's per-statement snapshot for its re-reads, so every path that relies on one (`intercompany_in_one_group`, every
  changer, the joiner, the sides guard) refuses with SQLSTATE 40001 at REPEATABLE READ or SERIALIZABLE, as migration 886 does for `company_users`
  (the application never runs these writers at another level). A party's own read-only user that keeps a transaction open can keep that pair's
  leave failing with 55P03 until it lets go: an accepted limit (a direct party, and an API request is too short to hold). platform_admin can still
  `LOCK TABLE` the group tables. `intercompany_company_locks` has a foreign key to `companies` that cascades (a company delete waits for a held
  lock row), and the changer's retry backs off exponentially (5 ms doubling to 1 s, jittered; about 18 attempts in 10 s) and is capped at 60 attempts as well as
  the time budget, so the bound is deterministic (same 55P03). The companies trigger and the join triggers are origin-only (a restore in replica mode skips them; the lock table restores itself, and a
  decider recreates a missing row). Tests: `company-locks-scope`, `group-race-matrix` (every kind of membership change x every kind of writer x
  both orders), `group-race-single`, `group-race-bulk`, `group-tables-grants`, `migration-backfill`. `intercompany_in_one_group` answers only for
  a signed-in user of one of the two companies (`auth.user_companies()`), never on the strength of the session's company GUC, so it is false when
  `auth.uid()` is NULL: **the P2 auto-accept worker needs its own definer path** (it must not reuse this check on a company GUC). A side's first
  save, a message send, accepting a message and a link insert or update hold their connection FOR SHARE, so a revoke in flight is waited for and
  seen. Active links and their slots survive a revoke until a party unlinks. Limits: row share locks do not queue behind a changer and a changer
  polls, so continuous overlapping traffic of one company pair can keep that pair's leave from finding a gap (it fails with 55P03 after the
  budget); an in-transaction "company share, then a row a changer holds" ends in 40P01 only. A message is still only an inbox item until a person
  (or, from P2, the receiver's auto-accept worker) acts on it.
- **Links.** A pending pairing holds no unique slot (the unique indexes cover ACTIVE links only; confirming re-checks them), so a partner
  cannot squat a document by proposing it. Confirming needs the connection active (unlinking does not), and the confirmed side's document must
  exist in its company (`intercompany_document_exists_as_writer`, a registered definer that answers only for a company in which the caller
  writes). One mirror link per message.
- **Messages and their documents.** An invoice / credit_note / interest_invoice message names a SOURCE document that exists in the sending
  company when it is sent (invoice, interest_invoice: a customer invoice; credit_note: a customer credit note), and an accepted one names a
  TARGET that exists in the receiving company (a supplier invoice; a supplier credit note); any target a handler sets is held to the same
  rule. A kind that creates no document (payment, allocation, reject, credit_request) carries no target (cleared). The mirror link re-checks
  both documents (`intercompany_message_documents_ok`, a registered definer that answers only for the receiver's session, because the
  receiver cannot see the sender's documents). `handled_via = 'auto'` only when the receiver's side has auto_accept on an active group
  connection; accept, reject and restore need the connection active (holding its row FOR SHARE, so a revocation at the same moment waits). A receiver
  document is the target of ONE accepted message per RECEIVING COMPANY, whatever the connection (guard + unique index `intercompany_messages_target_uq`).
- **A company document is in ONE link at a time, whatever the connection and the position.** `intercompany_document_slots` (a normalised
  company / type / id with a primary key; closed to every app role) is kept by a definer trigger on the links: an active link holds both
  documents, a pending pairing only the side its inserter confirmed (that document was checked to be the inserter's own). The other side of a
  pending pairing names an unchecked document, so it holds nothing (a partner cannot squat a document by proposing it); confirming takes the
  confirmed side's slot. The primary key serialises concurrent pairings (the second waits, then is refused), also across positions (doc_a of the
  low company on one connection, doc_b of the high company on another). The per-position unique indexes on active links stay as a second line.
  1002 refuses to be applied over duplicates, naming them, and backfills the slots of existing links.
- **A revoked connection also switches auto-accept off** (the release trigger), so a re-activated connection never starts auto-handling
  by itself; a no-op UPDATE of a connection (`SET status = status`) needs the same write role as a change (the migration's own backfill
  runs it as the system path).
- **Hard deletes.** A side's references are `ON DELETE SET NULL`; the foreign key's own UPDATE (one trigger level down, only references going to
  NULL) passes the sides guard whatever the connection's state, so a purge or a migration rollback is never blocked by a revoked connection.

## Phases (each = one PR, TDD, blind `/review`; GL-writing PRs get the adversarial ledger reviewer)

| # | PR | Depends on | Contents |
|---|----|-----------|----------|
| P1 | Connections (group) | — | migration (connections, sides, messages, links); service; Settings › Intercompany › Connections page with setup checklist; nav entry |
| P2 | Invoice + credit-note mirror | P1 | outbox insert in `approveCustomerInvoice` + customer credit-note approve (date ≥ cutover, active connection); Bills › "Intercompany" tab + badge; Accept / Reject(reason) / Dismiss; Accept → draft supplier invoice / supplier credit note with copied PDF and account mapping (side default, then last-used per sender line description); auto-accept worker (cron + timer); dup guard; link + `intercompany_transactions` row for group |
| P3 | Pre-cutover pairing | P1 | pairing screen: open AR of A vs open AP of B, suggest by number+amount, confirm → `intercompany_document_links` (no postings); exceptions list; loan-balance difference |
| P4 | Loan settlement + payment/allocation mirror | P2, P3 | `loan` mode: allocate payment → contra-settle invoice against loan account; `allocation` message → mirror clearing on paired doc (auto for group+auto-accept, else inbox); unpaired → mismatch; `payment` message → match suggestion on receiver bank lines (both modes) |
| P5 | Reconciliation + close | P4 | per-connection report (loan balance both sides, unpaired docs, pending/failed messages, mismatches); period-close checklist item; Group › Intercompany shows pairs |
| P6 | External connections | P2 | connection key (generate/rotate, hashed), invite by key → pending → accept/decline → revoke; auto-accept hidden + refused; reject/credit-request messages surface in sender's outbox view |
| P7 | Interest | P4 | side `interest_rate_pct`; month-end cron: avg daily balance of lender loan account → draft VAT-exempt interest invoice on lender; mirrors via P2 once approved |

DAG: P1 → {P2, P3} → P4 → {P5, P7}; P2 → P6.

**REVISED 2026-11-20 (P2 build, after six review rounds):** the sender never writes a document message (the database builds it from the approved
document, `intercompany_send_for_source`); auto-accept creates DRAFTS only (Hein); and the consolidation eliminations of mirrored documents are
DERIVED from the two ledgers at read time (`intercompany_mirror_eliminations`, as at the period end, keyed on the later of the two dates, cut-off by
the receiver's financial year, on the journals' own accounts), never stored, so no hook or lock stands between a ledger and a figure. P2 eliminates
revenue / expense only; the intercompany receivable / payable balances stay with P4 / P5.

## Validation gates (per PR, evidence required before queueing)

- `bun run ci` green; GitHub both required checks green on the PR head.
- **Integration suites** (`tests/integration/intercompany/*.int.test.ts`), two real tenants:
  - tenant isolation: sender cannot read receiver messages/docs/links; a third company sees nothing;
    revoked connection stops new messages; external connection refuses auto-accept (service and DB).
  - P2: approve invoice in A → exactly one message; accept in B → draft supplier invoice with same
    number/VAT/total; re-approve/retry → no second message; dup supplier+number refused.
  - P4: allocate R X in B against paired invoices → B: DR AP / CR loan; A: DR loan / CR AR; both loan
    balances equal; unpaired → mismatch, no posting.
  - P7: interest on a known daily-balance series equals hand calculation; invoice VAT = 0.
- Mutation check on each guard (break it, watch the suite go red).
- UI phases: load the page in a browser on dev with two QA companies; state what was seen.
- Dev only for data; never prod. Real Velocity/Blitz/Brighttech connections are set up by Hein/Willie
  after deploy (customer/supplier mapping + cut-over date + pairing are their decisions).

## Not building

Formal loan agreements / lender side of the loans module; FX (ZAR only — refuse non-ZAR documents
with a clear message); Peppol (SARS e-invoicing is still consultation); shared IC chart of accounts.

## Strongest argument against

This adds the first cross-tenant write path to a multi-tenant ledger. One RLS or context mistake in the
worker posts into the wrong company's books. Mitigation: messages-only from the sender, receiver-context
worker, DB-level RLS + unique constraints, integration suites that run as `app_user` across three
tenants, adversarial review on P2/P4/P6.
