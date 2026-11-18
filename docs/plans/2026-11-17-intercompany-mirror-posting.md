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

These supersede the Data model above wherever they differ (migration 999z carries them).

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

- **Migration prefix.** `999z_intercompany_connections.sql` (master took 999p; 999q-999y are in other open PRs).
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
- **Point-in-time race.** A connection or message created in the same instant that a company leaves a group (or the group is deleted) can
  commit just after the revoking trigger ran: the helper is checked at insert time, not held as a lock. The window is closed by re-checking
  at ACTION time: P2's auto-accept worker calls `intercompany_in_one_group` again, as the receiver, immediately before it creates the draft
  and approves it, and refuses (leaving the message pending) when it is false; the connection guard also makes any later message insert
  fail. A message sent inside the window is therefore at worst an inbox item a person decides on, never an automatic posting.
- **Links.** A pending pairing holds no unique slot (the unique indexes cover ACTIVE links only; confirming re-checks them), so a partner
  cannot squat a document by proposing it. Confirming needs the connection active (unlinking does not), and the confirmed side's document must
  exist in its company (`intercompany_document_exists_as_writer`, a registered definer that answers only for a company in which the caller
  writes). One mirror link per message.
- **Messages.** An accepted invoice / credit_note / interest_invoice message names a document that exists in the receiver's company;
  `handled_via = 'auto'` only when the receiver's side has auto_accept on an active group connection; accept, reject and restore need the
  connection active.
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
