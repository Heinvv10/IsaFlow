# Intercompany slice F: the `payment` message and match suggestions on the receiver, 2026-11-24

Parent: docs/plans/2026-11-17-intercompany-mirror-posting.md (rule 3 `cash` mode: "a payment on one side becomes a match suggestion on the
other side's bank line, never a posting"; P4 row: "`payment` message -> match suggestion"). F is the LAST intercompany payment slice. It stacks on
P4-B (1025), P4-C (1026), P4-D (1027), the dark flag (1028), P4-E (1029, its section (j) binding) and P5 (1030, open as #1871 on
`feat/ic-p5-reconciliation-20261124`). The builder branches off master only after P5 merges and re-reads 1027-1030 as merged: F replaces the
1027 messages guard body and the 1025 allocation sender, so a later edit to either on master must be carried into F's bodies.
**Sections (k), (l) and (m) are binding; (k) SUPERSEDES earlier text, (l) SUPERSEDES (k) and (m) (review round 1) SUPERSEDES (l)**; earlier
sections were edited to match them.

**Rulings (orchestrator, binding).** Suggestions are READ ONLY. Any accept creates a DRAFT only (a receiver `customer_payments` row with
`status = 'draft'`) or nothing at all; no journal is posted by F anywhere, in either company. There is NO auto-accept of payment messages in F
((k) Q4); a worker never self-approves. No change to `bankAllocationService` (or
any bank allocation / bank match service). A mismatch is STATE on the message (a word a read-only definer answers), never a guess and never a
silent pick. Reversals are out of scope (#1772). A pre-cut-over paired invoice or a locked period is REFUSED, never rolled forward. Everything is
behind the dark per-company flag `intercompany_loan_clearing` (1028, default OFF, fail closed): with the flag off for the payer no `payment` message
is written, and with it off for the receiver none is listed with an Accept, accepted or suggested. F also CLOSES the known gap that app_user can
INSERT a `kind = 'payment'` message directly. Known limits NOT re-reported: #1817, #1833, #1804, #1805, #1808, #1772, #1780, #1781, #1783, #1788,
#1760, #1855, #1872.

## (a) What it does
1. **Sender (payer P, CASH connection).** When P's posted cash meets a bill whose supplier is P's side `supplier_id` on an ACTIVE GROUP connection
   whose `settlement_mode = 'cash'`, AND the bill is one side of an ACTIVE link with the partner's customer invoice (LINKED bills only, (k) Q6),
   the database writes ONE `kind = 'payment'` message per `payment_allocations` row for the partner R (the issuer). It is written by a new
   registered definer, `intercompany_send_for_payment(p_allocation uuid)`, from P's own rows only, called by the SAME hook sites as the allocation
   message (`intercompany/allocationOutbox.ts`: `mirrorAllocations` from `applySupplierPaymentPlan`, `mirrorPaymentAllocations` from
   supplierPaymentWorkflowService.ts:171, `mirrorBatchAllocations` from batchPaymentService.ts:252). Each allocation id gets its own savepoint and
   the two definers run in a FIXED order inside it ((k) L-4); at most one of them writes (section (d)). A loan connection never gets a `payment`
   message (that is the `allocation` kind's).
2. **Receiver (R), read only.** R's inbox gains a "Payments" list (kind `payment`, R = `to_company_id`). For each message R sees the payload
   (payer's payment number, reference, date, amount, bill number) and a state word from a new receiver-only definer
   `intercompany_payment_message_state(p_message)` (section (b)). The detail shows MATCH SUGGESTIONS computed on request from R's own rows
   only: (i) the linked issuer invoice (always present: F sends linked bills only) and, below it, R's other open invoices of the side's
   `customer_id`; (ii) R's receipts in the candidate set of (l) MED-2; (iii) R's unmatched incoming bank lines (`bank_transactions` of R,
   `amount > 0`, status `imported`) as a hint only, with no action. Nothing is stored; viewing writes nothing.
3. **Receiver accept (a person in R).** Two outcomes, chosen explicitly:
   - `existing`: "this is my receipt RC-x" (a suggestion of kind (ii)): the message is accepted with target `customer_payment` = that receipt.
     NO document, allocation or journal is written; the receipt stays as it is (its allocations are R's own business through the normal screens).
   - `draft`: "draft a receipt for it": ONE `customer_payments` row, `status = 'draft'`, `payment_method = 'eft'`, `bank_reference = 'IC:<message id>'`,
     `bank_account_id` = a bank account of R the person picks, `payment_date` the person picks, allocated through `customer_payment_allocations`
     to the open invoice(s) the person picks for exactly the payload amount, created through `createCustomerPayment` (ar/customerPaymentService.ts:
     its invoice locks and its open-less-pending-drafts cap apply), then the message is accepted with that draft as target. Confirming the draft
     is R's normal receipt Confirm (`confirmCustomerPayment`) by a person with the approve right, behind F's confirm gate ((k) H-3).
     Discarding it returns the message to `pending` ((k) Q1).
   Reject / Dismiss / Restore work as for the other kinds (the existing guard paths).

## (b) Every write, every definer, and the reversal path
**Journals posted by F: NONE, in either company.** Writes:
| write | table / status | by | reversal path |
|---|---|---|---|
| W1 payment message | `intercompany_messages` kind `payment`, `source_doc_type = 'payment_allocation'`, `source_doc_id` = the `payment_allocations.id`, status `pending`, `source_journal_entry_id` = the payment's standing journal (own, else its batch's) | `intercompany_send_for_payment` (owner migration_admin) in P's transaction | none new (#1772). While the message is not accepted, P voids / unapplies with the existing flows: the message is NOT withdrawn; R's state word turns `payer_gone` and R's Accept refuses. Once R ACCEPTED it, P's void / unapply / journal reversal is REFUSED ((k) H-1, (l) MED-1). |
| W2 accept `existing` | the message: `status = 'accepted'`, `target_doc_type = 'customer_payment'`, `target_doc_id` = R's receipt | R's person, app_user UPDATE through the guard; one receipt may absorb several payment messages up to its total ((l) MED-2) | none: R later cancelling that receipt (`cancelCustomerPayment`) leaves the message accepted, state `target_cancelled` (named residual, (h)). |
| W3 accept `draft` | `customer_payments` (status `draft`) + `customer_payment_allocations` rows, then W2 naming the draft | R's person, app_user, one request transaction | W5 discard. |
| W4 confirm of the draft | NOT F's write: R's normal Confirm posts DR bank / CR AR, behind F's confirm gate ((k) H-3) | R's person (approve right) | R's normal receipt cancel (message stays accepted, `target_cancelled`). |
| W5 discard of an F draft | draft -> `cancelled`; the message `accepted` -> `pending`, target cleared (system transition `redraft`); one `audit_log` row | D4 `intercompany_discard_payment_draft` ((k) Q1), approve right | none (the message is open again; a new accept is the way forward). |

New SQL (migration 1031 or the next free prefix: P5 holds 1030; re-check `ls scripts/migrations/sql` and open PRs before every push; forward
only; `SET LOCAL lock_timeout '5s'`; rollback header in the 1025/1027 style naming EXACTLY which earlier statements to restore):
- **D1 `intercompany_send_for_payment(p_allocation uuid) RETURNS TABLE(message_id uuid, reason text, detail text)`**, SECURITY DEFINER, VOLATILE,
  owner migration_admin, `search_path = pg_catalog, public, pg_temp`, REVOKE PUBLIC, GRANT EXECUTE app_user. The 1025 body's shape (tighten-only
  2 s lock bound, `<<main>>` exits, one INSERT ... ON CONFLICT DO NOTHING). Reasons in order: `no_session`, `not_found` (NULL input), `forbidden`
  (`intercompany_user_can_write`), `not_enabled` (P's flag: `company_feature_overrides` row else `feature_flags.is_global`, no plan read, fail closed:
  1029's `receiver_flag_off` rule applied to P; see (k) L-2), `not_found` (allocation / payment / bill not P's or bill deleted), `no_journal` (no standing root), then the PAYER JOURNAL KEY of the root read
  from P's payment row ((l) MED-4: before any link / connection share; every later check re-reads after the wait),
  `not_partner_supplier` (the bill's `supplier_id` is P's side `supplier_id` on no ACTIVE CASH connection of P), `ambiguous` (it is on more than
  one: no LIMIT 1, (k) Q6), `not_linked` (the bill holds no ACTIVE link on THAT connection to a customer invoice of R; slot
  `intercompany_document_slots`, 1025's join, link and connection FOR SHARE AFTER the key), `no_connection` / `not_group` / `not_cash`, `no_cutover` /
  `before_cutover` (the CONNECTION's `cutover_date`, payment date, exactly 1025's and 1027's live rule, (l) MED-3), `not_posted` / `no_journal` (1025's rule:
  processed or reconciled, `COALESCE(sp.gl_journal_entry_id, batch.gl_journal_entry_id)` with odd `intercompany_journal_chain_length`),
  `through_loan` (that journal credits P's side `loan_account_id`), `not_cash` ((m) MED-1: a contra set-off or a journal crediting no money
  account), then `allocation_sent` (an `allocation` message for this allocation row
  exists), `superseded` ((l) MED-1: keyed on the payment id) and `already_sent`.
  Payload v1 (text through `intercompany_clean_text`, money 2 dp): `{ version:1, kind:'payment', allocationId, amount, currency, payment:{ id,
  number, reference, date, method }, payerDocument:{ type:'supplier_invoice', id, number, date }, issuerDocument:{ type:'customer_invoice', id },
  linkId }`. No `cashLegIsLoanAccount` (always false by construction). Non-ZAR is sent; R refuses.
- **D2 `intercompany_payment_message_state(p_message uuid) RETURNS TABLE(live boolean, state text)`**, SECURITY DEFINER, STABLE, no lock, owner
  migration_admin, GRANT app_user. Receiver only: session company = `to_company_id`, signed-in member, `kind = 'payment'`, else
  `(false, 'not_found')`. Words, first wins: `connection_gone` (not active / not group / not one group via `intercompany_shared_group`, NOT the
  VOLATILE `intercompany_in_one_group`), `not_cash` (the connection is no longer on cash, (m) LOW-1), `not_enabled` (R's flag), `future_dated` (payload date after today, Johannesburg), `before_cutover` (payload payment date before the connection's `cutover_date`, (l) MED-3),
  `payer_gone` (H1 below is false), `link_gone` (the payload's link is no longer active), `currency`, then for an accepted message
  `target_cancelled` (target receipt status `cancelled`) / `target_ok`, `closed` for a rejected / dismissed / failed message ((m) B6), else
  `open` (pending). One word, no figure, no id, no partner text. The guard (G1)
  and the confirm gate ((k) H-3) both ask it.
- **H1 `intercompany_payment_payer_standing(p_message uuid) RETURNS boolean`**, STABLE INVOKER, EXECUTE migration_admin only: 1029's
  `intercompany_allocation_payer_standing` body with `m.kind = 'payment'`. (Not a definer; not registered.)
- **H2 `intercompany_payment_target_ok(p_message uuid, p_payload jsonb, p_connection uuid, p_receiver uuid, p_type text, p_id uuid) RETURNS
  boolean`**, STABLE INVOKER, GRANT app_user (the guard calls it as the session, like 1027's `intercompany_allocation_target_ok`). True only when
  D2's state for `p_message` is `open` ((k) H-2) AND: `p_type = 'customer_payment'`, the row is R's (`company_id = p_receiver`), `client_id` = R's
  side `customer_id`, `payment_method <> 'contra'`, `payment_date >= payload payment date` and EITHER (draft) `status = 'draft'`,
  `bank_reference = 'IC:' || p_message`, `created_by = auth.uid()`, `total_amount` = payload amount, its allocations sum to it and every allocated
  invoice is R's, of that customer, ZAR, open and dated on or after the connection cut-over; OR (existing) the receipt is in the (l) MED-2
  candidate set (journal chain odd) and its UNCONSUMED amount >= the payload amount, read after the receipt row lock.
- **H3** `intercompany_allocation_cap_lock` (1027, INVOKER): CREATE OR REPLACE with `m.kind IN ('allocation','payment')`, so a payment accept
  holds the payer's payment / journal / bill keys exactly as a clearing does ((k) H-1).
- **G1 messages guard** (CREATE OR REPLACE of the 1027 body, every other line unchanged): (1) the GAP: add `'payment'` to the
  `current_user <> 'migration_admin'` refusal list (42501), so only D1 can write a payment message; (2) `intercompany_message_doc_exists` gains a
  `kind = 'payment'` source branch identical to `'allocation'`'s, and the guard's source check list gains `'payment'`; (3) a target branch
  `ELSIF NEW.kind = 'payment'`: accepting runs `PERFORM intercompany_allocation_cap_lock(OLD.id)`, THEN (its own statement, so a snapshot taken after
  the wait) `intercompany_payment_target_ok` (23514 otherwise) and the (l) MED-2 consumption rule in place of one-message-per-target; the target changes on
  no other person transition (23514); (4) the system branch gains `v_system = 'redraft'` ((k) Q1), exempt per (l) LOW-1. `reject` and `credit_request` stay open to app_user.
- **D3 `intercompany_send_for_allocation`** (CREATE OR REPLACE of the 1025 body): takes the payer journal key FIRST, before its link /
  connection FOR SHARE ((l) MED-4), checks P's flag in SQL exactly as D1 ((k) L-1), KEEPS 1025's connection cut-over rule ((l) MED-3), and refuses `payment_sent` when a `payment` message for the allocation row
  exists. Re-registered (new hash).
- **D4 `intercompany_discard_payment_draft`** ((k) Q1). **IX1** `CREATE UNIQUE INDEX IF NOT EXISTS intercompany_messages_one_payment_kind ON
  intercompany_messages (from_company_id, source_doc_id) WHERE source_doc_type = 'payment_allocation' AND kind IN ('allocation','payment')`: the
  database authority for (d). Pre-check in the migration: zero duplicate rows (no payment message has ever been written by code), else HALT.
  **IX2** narrows 1002's `intercompany_messages_target_uq` to `kind <> 'payment'` ((l) MED-2); the rollback header names 1002:258 to restore.
- **Flag text:** `UPDATE feature_flags SET description = ...` for `intercompany_loan_clearing` ((k) Q5).

## (c) Refusals
**Sender (D1):** the reason words above; the hook stays silent on every one (as 1025) except `not_found` / `no_journal` / `ambiguous` /
`superseded` (log.error) and `not_posted` / `no_cutover` / `before_cutover` (log.warn, (l) MED-3); a lock timeout is log.error with its SQLSTATE ((k) M-4); it never throws, so the payment
stands. **Receiver accept** (`acceptPaymentMessage`, route `POST /api/accounting/intercompany/payments/[id]/accept`,
`withAuth(withErrorHandler(...))`), ALL from reads before any write, plain 4xx: flag off for R (403 `not_enabled`, before anything is read);
session actor not 'self' (`currentSessionActor`, 403); no intercompany write role or no create right on customer receipts (403); message not R's /
not `payment` (404, one body); status not `pending` (409); D2 state not `open` (409 with its sentence); `existing`: receipt outside the (l) MED-2
candidate set or unconsumed amount short (422); `draft`: the (l) MED-2 draft refusal (422), bank account not
R's active bank account, invoice not R's / not the side's customer / not open (AR_OPEN_STATUSES) / not ZAR / dated before the connection cut-over
(`pre_cutover_invoice`), amounts not whole cents or not summing to the payload amount (no partial in F), exceeds open less pending drafts,
`payment_date` before the payload payment date or after today, period with no open fiscal period / locked / VAT-locked (`postingDateRefusal`,
allocationClearDate.ts: refused, never rolled forward); `expected` (amount, state, invoice ids) differs from what the person saw (409). After the
first write (the draft) any failure throws a plain Error: 5xx, the request transaction rolls back (withAuth commits a 4xx). The ordinary receipt
create refuses a caller-supplied `bank_reference` starting `IC:` (only `acceptPaymentMessage` sets it). Lock order: (k) M-3.

## (d) Zero double count, vs the P4 allocation message
- **Z1 one message per payer allocation row.** For every `payment_allocations` row a of payer P: count of messages from P with
  `source_doc_type = 'payment_allocation'`, `source_doc_id = a` and `kind IN ('allocation','payment')` is at most 1. Authority: IX1 (a race loser
  gets 23505, which each definer's ON CONFLICT does NOT absorb because 1000's `intercompany_messages_once` includes `kind`, so each definer checks
  the other kind first). Clean refusal: both D1 and D3, BEFORE their link / connection FOR SHARE and their existence checks, take the PAYER
  JOURNAL KEY of the payment's standing journal root: `pg_advisory_xact_lock(hashtextextended(P::text || ':journal:' || root::text, 1027))`, the
  same key 1027's cap lock and the payer undo gate take. Order: payer journal key -> link FOR SHARE -> connection FOR SHARE -> existence check ->
  INSERT ((l) MED-4). Neither definer locks a journal row. The lock census is (l) MED-4.
- **Z2 modes exclude each other at an instant.** D1 requires `cash`, D3 `loan`, each under the connection FOR SHARE (a mode change is an UPDATE
  of that row and waits). Z1 covers the case across time (a mode change between two events on the same allocation row).
- **Z3 the receiver's AR moves once per message.** A message names at most one target. A receipt absorbs accepted payment messages only up to
  its `total_amount` (consumption, (l) MED-2), so a split payment's N messages can all land on R's one bank receipt and no receipt is counted
  past its cash; a P4-D clearing receipt is contra (H2 refuses contra) and an F draft carries one `IC:<m>`, so neither is shared across kinds. `existing` writes no allocation; `draft` allocates exactly the payload amount under
  `createCustomerPayment`'s invoice locks and open-less-pending-drafts cap. A discard returns the message to `pending` with no target, so at
  most one live target exists at any time.
- **Z4 the payer's books.** F writes nothing on P beyond W1. Unapply + re-apply of an accepted payment (a second allocation row, a second message)
  is closed by the undo gate, the unapply's keys and `superseded` ((l) MED-1).
- **Residual (named, not prevented by F):** see (h) R1.

## (e) Cross-tenant disclosure
- **What R learns** (only through W1's payload, which P's own rows built): P's payment id, number, reference, date, method, amount and currency;
  P's bill id, number and date; the allocation row id; the link id; nothing else of P. This is the allocation payload's set minus
  `cashLegIsLoanAccount`, plus the bill date (to show the cut-over refusal). D2 adds coarse words about P: whether P's payment still stands
  (`payer_gone`) and whether the link still holds. No figure, no id, no partner text beyond the payload.
- **Suggestion scoring reveals nothing about P.** It reads, as app_user under R's RLS: the message row (party_read), R's side, R's
  `customer_invoices`, `customer_payments`, `customer_payment_allocations`, `bank_transactions` and `bank_accounts`. P's rows are never read
  (ranking of receipts and bank lines uses the payload only: amount, date, reference text, via the pure `scoreAmount` / `scoreDate` /
  `scoreDescription` of bank/bankMatchCandidatesService.ts; the linked issuer invoice id). Suggestions are not stored, so P cannot observe that R
  looked.
- **What P learns back:** the message's status, reject reason and `target_doc_type` / `target_doc_id` (party_read already shows them for every
  kind): that R accepted, and the uuid of R's receipt (an id with no readable content). A discard shows P the message back at `pending` with no
  target (that R discarded its draft). Accepted limit, same as P2 / P4. P never learns which of R's invoices or receipts was suggested, nor any R
  figure. P's undo refusal sentence ((k) H-1) tells P that R accepted, which the status already shows.
- **Third company C / a user of both:** RLS `party_read` / `sender_insert` / `receiver_update` (1000) unchanged; D1, D2, D4 read
  `app.current_company_id()` only and take no company argument; a user of both P and R in session P sees P's perspective only.

## (f) Definers, 930 registration, grants
Registered in `app_definer_reviews` (930) AFTER create and owner change, `body_md5 = app_definer_hash(fn::regprocedure)`, `writes` naming every
table read / written: **D1** (writes one `intercompany_messages` row; reads `payment_allocations`, `supplier_payments`, `supplier_payment_batches`,
`supplier_invoices`, `gl_journal_entries`, `gl_journal_lines`, `intercompany_document_slots`, `intercompany_document_links` FOR SHARE,
`intercompany_connections` FOR SHARE, `intercompany_connection_sides`, `feature_flags`,
`company_feature_overrides`, `company_users`, `intercompany_messages`; takes one advisory key), **D2** ("nothing (STABLE)": reads the message,
connection, sides, links, flags, the payer standing tail via H1, R's target receipt), **D3** (re-registered, new hash, `writes` + "and a read of
payment messages, feature_flags, company_feature_overrides"), **D4** (writes one `customer_payments` row's status and the
message's redraft; reads the message FOR UPDATE, `customer_payments` FOR UPDATE, `company_users`, the approve-right tables).
INVOKER, not registered: H1 (EXECUTE migration_admin only), H2 and H3 (EXECUTE app_user), G1 and `intercompany_message_doc_exists` (body changes;
owner and grants untouched). Deploy-safe grant block as 1027/1029: REVOKE PUBLIC on all; any other role able to EXECUTE gets REVOKEd, a revoke the
migration role cannot make is a WARNING; HALT on PUBLIC execute, app_user missing on D1/D2/D4/H2/H3, app_user having H1, owner not migration_admin,
hash mismatch, search_path not pinned. No table grant changes: app_user keeps its 1000 column INSERT grant (reject / credit_request use it); the
gap is closed in the guard, which fires for every role (`ENABLE ALWAYS TRIGGER trg_intercompany_messages_guard`, 1019).

## (g) Tests first
Integration (`tests/integration/intercompany/payment-*.int.test.ts`, as app_user; P and R on an active group CASH connection, C a third company
in the group with a connection to P only, plus a LOAN connection; flags on by override unless the test says otherwise):
- **Gap closed:** app_user INSERT of `kind = 'payment'` (any `source_doc_type`) refused 42501. Update every suite that uses `payment` as a generic
  probe (`messages.int`, `messages-guards.int`, `messages-documents.int:76,140,243-261`, `group-race*.int`, `mirror-crosstenant.int:106`,
  `release-links.int:79`, `allocation-tenancy.int`, `allocation-live-tenancy.int`, `company-delete.int`, `company-locks-scope.int`, ...) to `reject`
  / `credit_request`, and `plantMessage` (intercompany.plant.ts:87) to plant a real allocation row for kind `payment`; grep `'payment'` in
  tests/integration/intercompany for the full list before the first push.
- **Sender:** one message per allocation row with payload equal to P's rows; batch and split payments give N messages; each refusal word writes
  nothing (flag off for P, loan connection, revoked, external, pre-cut-over payment (connection cut-over, logged warn), not the partner's supplier, UNLINKED bill
  `not_linked`, supplier on two cash connections `ambiguous`, draft / approved payment, journal reversed, journal credits the loan account);
  idempotent re-call and re-process; no session -> silent; viewer `forbidden`; a forced definer failure leaves the payment committed; a held key
  makes D1 time out and the hook logs error with 55P03 ((k) M-4).
- **Z1:** same allocation row offered to D1 then D3 and D3 then D1 (mode flipped between, via fixture): one message; two concurrent sessions
  racing D1 and D3 on the same row: one message, the loser answers `allocation_sent` / `payment_sent` (barrier through the sql wrapper after the
  key); IX1 present and refusing a migration_admin-forged second kind; a forged 23505 inside the hook's savepoint is logged `other_kind_sent`, not
  error ((k) L-4).
- **Suggestions:** linked issuer invoice ranked first; pre-cut-over and closed invoices not offered; another customer's invoice never offered; the
  (l) MED-2 candidate rules each tested; C's / P's rows never read (statement log check on a spy); no write (row counts, `updated_at`).
- **Accept:** `existing` writes only the message row; `draft` writes exactly one draft receipt + its allocations and no journal (journal counts
  in both companies unchanged); each (c) refusal writes nothing; R flag off 403 before any read; impersonation 403; expected mismatch 409; locked /
  VAT-locked date refused; a forced guard refusal after the draft insert leaves no draft (5xx rollback); direct app_user UPDATE to `accepted`
  with no target / a contra / another customer's receipt / a P4-D clearing receipt refused 23514; a second message onto the same receipt past its total refused;
  the (k) H-2 cases.
- **Undo gate ((k) H-1, (l) MED-1):** after R accepts, P's unapply, void (route, MCP, batch) and journal reversal are refused; D1 `superseded` with the gate
  bypassed by fixture; while pending, void still works and R sees `payer_gone`.
- **Confirm gate / discard ((k) H-3, Q1):** confirm of an IC draft with state `target_ok` posts (creator or another approver);
  with R's flag off / payer gone / link gone refused, nothing written; a normal draft forged with `IC:<m>` refused at create and at confirm;
  discard: draft `cancelled`, message `pending` with no target, invoice open amount restored, audit row, only an `IC:` draft of a received
  message, a confirmed one refused, a concurrent confirm + discard yields exactly one outcome; P4-D's contra confirm path unaffected.
- **State words:** payer void -> `payer_gone` and accept refused; unlink -> `link_gone`; revoke -> `connection_gone`; R cancels the target
  receipt -> `target_cancelled`.
- **Unsent read ((k) M-4):** a cash-paid linked bill with no message (flag off at send, forced timeout) is listed for P; C and R see nothing.
- **Registry / grants:** D1, D2, D3, D4 in `app_definer_reviews` with hash; PUBLIC cannot execute; app_user cannot execute H1; app_pool_reach passes.
Unit: sender reason -> log level; suggestion ranking (pure); refusal order and sentences; payload parse. Component: Payments inbox list, detail
with suggestions, the two accept outcomes, discard, the receipt's IC state chip, no Accept when the flag is off, state chips. Mutation checks
(each must go red): drop `'payment'` from the guard's migration_admin list; drop D1's `not_cash`, flag, `through_loan`, `allocation_sent`,
`not_linked`, `ambiguous`, `superseded` checks; drop D3's `payment_sent` and its SQL flag check; drop IX1; drop the key; drop the D2 `open` line in
H2; drop H3's `'payment'`; drop `company_id = R` / customer / contra / status checks in H2; let the draft carry a partial amount; drop
`postingDateRefusal`; read P's rows in suggestions; drop `'payment'` from the undo gate and from `lockPayerJournalKey`; drop the confirm gate's
state check; drop D4's `WHERE status = 'draft'`. Browser proof on a throwaway QA company pair (not Demo). Reviews: blind
rounds, adversarial ledger review and a policy-breaker (cross-tenant read, oracle, double count, forged insert) before the queue.

## (h) Not in F
Any journal; any bank allocation, bank match or `bankAllocationService` change; auto-accept of payment messages ((k) Q4); messages or scored
suggestions for UNLINKED bills of the partner's supplier ((k) Q6, later slice); loan-mode non-invoice advances as "loan-movement" suggestions
(parent rule 6; F2); payments on account (no allocation row); external connections (P6); following reversals or withdrawing a message on payer
void (#1772); FX; partial accepts; storing suggestions; P5 report rows for payment messages (P5 is loan-only, (k) M-4); re-send; a general
draft-receipt discard. **Named residuals:** R4 ((m) LOW-2) a receipt of the customer dated on or after the payment whose cash is allocated elsewhere (R's R200
receipt put R100 on I1 and R100 on I3; message m2 is R100 on I2) is no `existing` candidate, so a draft for m2 is possible: it needs the
person's explicit confirmation that none of the listed receipts holds the payment (a hard warning, not a block); a person who confirms
wrongly doubles the cash, shown by R's bank reconciliation. R1 R confirms an F draft (DR bank) AND later allocates the same bank line as a new receipt through the
bank screen (DR bank again): the invoice cap stops it when the invoice is fully paid, a second open invoice of the same customer is not protected;
mitigated by the Q2 rule, the draft's warning "match the bank line to this receipt, do not allocate it again", and R's bank reconciliation
showing the doubled debit. R2 an accepted message whose target receipt R later cancels (confirmed `existing` or confirmed F draft) stays accepted
`target_cancelled`: no redraft for it in F. R3 closed by (l) MED-1 (unapply takes the keys); an accepted message whose allocation row is gone
by any other path still makes D1 refuse `superseded` for the whole payment.

## (i) Ways F could be wrong or leak, and the prevention
1. **Forged payment message by app_user** (today's gap): payload says anything. G1 allow-lists migration_admin for `payment`; test 42501.
2. **Same allocation row as both allocation and payment message** (double clearing + receipt): IX1 + payer journal key + both definers check the
   other kind; race test.
3. **Draft receipt plus bank-line allocation doubles the cash** on R: `existing` preferred, `draft` refused while an exact `existing` candidate
   exists (Q2), invoice cap, warning text; residual R1 in (h).
4. **Accept auto-picks an invoice** (a guess): no default selection posts; the person picks; no auto-accept for payment in F (Q4).
5. **A P4-D contra clearing receipt reused as a payment target**: H2 refuses `contra`; target_uq (still covering every other kind, IX2).
6. **Pre-cut-over invoice or locked period drafted**: refused in the service AND H2 (cut-over); `postingDateRefusal` before any write.
7. **4xx after the draft insert commits a half accept**: all refusals from reads first; after the first write only 5xx.
8. **Scoring reads P's books** (disclosure): suggestions query R's tables only; a test spies the statements and fails on any P-company table read.
9. **State definer is an oracle on P** (e.g. `payer_gone` for any message id): receiver-session only, `kind = 'payment'`, one `not_found` for
   everything else; tested with C and with P's own session.
10. **Flag off but message still sent or accepted**: D1 and D3 check P's flag in SQL (not only the hook); accept checks R's flag first; D2 answers
    `not_enabled` and H2 requires `open`, so even a direct UPDATE fails; list/detail show no Accept. Mutation per check.
11. **Mode flip loan -> cash after an allocation message** sends a payment message for the same row: Z1 (IX1 + `allocation_sent`).
12. **Lock cycle** (40P01 with payer void / P4-D cap lock / discard): one order per side ((k) M-3, H-1 census), no journal row lock in the
    senders; tighten-only 2 s bound; a timeout is the hook's logged error plus the unsent read, never a thrown payment.
13. **Stale `existing` receipt** (cancelled or re-allocated between view and accept): H2 re-judges in the guard under the message lock; `expected`.
14. **Draft that can never be discarded** blocks the invoice: D4 (Q1).
15. **Non-ZAR payment matched against a ZAR invoice**: D2 `currency`, accept refused.
16. **Receiver learns the payer's other partners** through the payload text: payload is built by D1 from fixed columns through
    `intercompany_clean_text`; no free payer text beyond reference / number.
17. **Probe suites silently stop testing the guard** once `payment` is closed: every probe moved to `reject` / `credit_request` and a census test
    that each suite still sends at least one message.
18. **Payer unapplies and re-applies an accepted payment** (second message, second receipt on R): undo gate + unapply keys + `superseded` ((l) MED-1).
19. **Guard weaker than the service** (a direct UPDATE accepts what the service refuses): H2 requires D2 `open` ((k) H-2).
20. **Confirm of an IC draft whose message went bad**: the confirm gate ((k) H-3).

## (j) Open questions: DECIDED (orchestrator, 2026-11-24); the rulings are (k)
Q1 discard: an IC-only discard definer that also redrafts the message. Q2 `draft` refused while an exact candidate exists, with a defined
candidate set. Q3 the allocation row is the source, plus the H-1 gate. Q4 no auto-accept. Q5 one flag, description reworded. Q6 linked bills
only; one active cash connection per supplier or `ambiguous`.

## (k) Design review round 0: binding changes (SUPERSEDES earlier text)
- **Q1 / M-1 / M-2 discard.** D4 `intercompany_discard_payment_draft(p_message uuid, p_payment uuid, p_reason text) RETURNS TABLE(ok boolean,
  reason text)`, SECURITY DEFINER, VOLATILE, owner migration_admin, registered, GRANT app_user. ONE transaction (the request's), in this order:
  session company = `to_company_id`, member with the intercompany write role; message FOR UPDATE (`kind = 'payment'`, `status = 'accepted'`,
  target = `p_payment`); payment FOR UPDATE (company R, `bank_reference = 'IC:' || p_message`, `payment_method <> 'contra'`); `UPDATE
  customer_payments SET status = 'cancelled', cancelled_by/at, reason WHERE id = p_payment AND company_id = R AND status = 'draft' RETURNING id`
  (no row: `not_draft`, nothing written); then the message through the new system transition (`app.intercompany_system_update = 'redraft'`):
  G1 allows ONLY `OLD.status = 'accepted' AND NEW.status = 'pending'`, kind `payment`, `target_doc_type/id` -> NULL, handled_* -> NULL,
  `manual_only` true, `source_cancelled_at` and counters unchanged; the system branch's "no target change" line exempts `redraft` only. Allocation
  rows stay (as `cancelCustomerPayment` keeps them); the open-less-pending-drafts cap counts `status = 'draft'` only
  (customerPaymentService.ts:136), so the invoice reopens. Service `discardIcDraftReceipt` takes the message lock then `lockCustomerPaymentForUpdate`
  (paymentLock.ts:101) before calling D4, and writes one `audit_log` row (who, when, reason, message id) with `logAuditOrThrow` in the same
  transaction. Route `POST /api/accounting/intercompany/payments/[id]/discard-draft`, gated by `refuseWithoutApprove(..., 'customers', 'customer
  receipts')` exactly as receipt cancel (customer-payments-action.ts:40-45), self session only. Integrity: `gl/integrityChecks/` reads no
  `customer_payments`; `party_ledger_check`'s `cancelled_payment_journal_stands` keys on a journal, which a draft never has. The builder re-greps
  readers of `customer_payments.status = 'cancelled'` and adds a test that every integrity check and party_ledger_check is clean after a discard.
- **Q2 / M-5 candidate set** for `existing` (and the `draft` refusal): R's receipts with `company_id = R`, `client_id` = the side's customer,
  `status IN ('confirmed','reconciled')`, `payment_method <> 'contra'`, `payment_date >= payload payment date`, NOT the target of any accepted
  message, not stamped `IC:` for another message, unallocated remainder >= the amount. `draft` is refused
  (422) while a candidate's remainder equals the amount exactly. H2's `existing` branch checks the same set. Residual: R1 in (h).
  SUPERSEDED by (l) MED-2 and LOW-2.
- **Q3 + H-1 undo gate.** Source stays the `payment_allocations` row. In `allocationUndoGate.ts`, `loanClearedUnapplyRefusal`,
  `partnerClearedRefusal` and `partnerClearedJournalRefusal` read `kind IN ('allocation','payment')` (the loan-credit check stays
  allocation-only); `lockPayerJournalKey`'s EXISTS (payerJournalKey.ts) reads the same; H3 widens the receiver's cap lock. Lock census, redone:
  journal reversal flows (`claimJournalReversal`, `lockJournalAndUnmatch`, `lockChainHead`) now take the key for a payment-message root too, still
  key-then-row; the payer void takes payment / journal / bill keys before any journal row; the document cancels reverse document journals no
  message stands on (both kinds record the payment's journal), so still no key; D1/D3: key -> link -> connection ((l) MED-4), no journal row; the receiver:
  message FOR UPDATE -> keys (H3) -> receipt -> invoices. [Unapply and `superseded`: SUPERSEDED by (l) MED-1.] The builder re-runs this census against master before coding.
- **H-2.** H2's first condition is D2(`p_message`).state = `open`, evaluated in the guard after H3's keys, under the message row lock the UPDATE
  holds (R flag, payer standing, link / connection liveness, `future_dated`, `currency`, cut-over), like 1027's target_ok over
  `intercompany_allocation_clearable`; plus `payment_date` within [payload date, today]. Test: a normal draft forged with `IC:<msg>` (fixture
  bypassing the create refusal) plus a direct app_user UPDATE to `accepted` fails 23514 when the payer voided, R's flag is off, the link is gone or
  the payload is future-dated; mutation: drop the `open` line and each of those tests goes red.
- **H-3 confirm gate.** New `intercompany/icDraftConfirmGate.ts` (customerPaymentAllocationService.ts is 279 lines), called at the top of
  `confirmCustomerPaymentInner` BEFORE `lockCustomerPaymentForUpdate`: an unlocked read of the draft's `bank_reference` / `payment_method`; if
  non-contra and `IC:<m>` with m a `payment` message to R: lock m FOR UPDATE (message first, M-3), then the caller locks the payment and the
  gate re-reads `bank_reference` (changed: 409 retry); refuse unless D2(m) = `target_ok` with target = this draft (which implies the payer stands,
  the link and connection hold, R's flag is on) (L-5 dropped, (l) LOW-3). P4-D stamps its contra receipt after confirm and is
  out of the gate; the gateway and contra confirm callers never carry `IC:` on a non-contra draft. The receipt screen shows the IC state word.
- **M-3 one lock order** for accept, discard and confirm: message FOR UPDATE -> payer keys (accept only) -> payment -> invoices (P4-D's order,
  allocationClearService.ts:15).
- **M-4 lost message.** A D1 lock timeout (55P03) inside the hook is `log.error` with its SQLSTATE, never silent. Shipped with F: a payer-side read
  "paid, no payment message" (cash connection, processed / reconciled allocation on a linked partner bill past the connection cut-over, no message of
  either kind), as `GET /api/accounting/intercompany/payments/unsent` on P's Payments outbox, flag and write role gated, 500 rows oldest first.
  Not the P5 report: P5 is loan-only and 404s a cash connection by design (its (m).12 no-oracle rule); widening it would change its badge.
- **Q6 / M-6.** Linked bills only (`not_linked`). The bill's `supplier_id` must resolve to EXACTLY ONE active cash connection side of P, else
  `ambiguous` (log.error); the link's connection must be that one. No LIMIT 1 (1025's link select keeps its own, unchanged for D3).
- **L-1.** D3 checks P's flag in SQL with D1's rule (no plan read, fail closed).
- **L-2.** The hook asks `hasFeature` (override, then `is_global`, then the PLAN); D1/D3/D2 read override then `is_global`, no plan. A flag
  granted only through a plan reads on in TS and off in SQL: no message, no accept (fails closed). 1028 puts it in no plan; documented in
  loanClearingGate.ts's header.
- **L-3 [SUPERSEDED by (l) MED-3]** one cut-over rule: the PAIR cut-over (`intercompany_pair_cutovers` over P's current groups, 1029's rule) for both kinds, payment date
  and bill date; D3's 1025 `c.cutover_date` test is replaced.
- **L-4 hooks.** `send()` in allocationOutbox.ts calls D3 FIRST and D1 only when D3 answers `not_loan`, each in its own inner savepoint; a 23505 on
  IX1 / `intercompany_messages_once` from either is logged info `other_kind_sent` (the row already has its message), never the outer
  "not written" error.
- **L-5 [DROPPED by (l) LOW-3].** The creator may not confirm their own IC draft: the confirm gate refuses `created_by = confirmer` ("a worker never self-approves").
  Cost: a one-person company cannot confirm one; it discards and receipts by hand.
- **Q4** no auto-accept of payment messages. **Q5** one flag; F's migration sets its description to "Intercompany payment messages: loan-mode
  clearing (allocation messages) and cash-mode payment match suggestions (payment messages). Off by default."

## (l) Verification round: binding changes (SUPERSEDE (k) and all earlier text)
Checked against 1002:258, 1019:1584, 1025:295-315, 1027:162-174 and 1027:479-575, customerBankReceipt.ts:24, bankAllocationService.ts:258.
- **MED-1 unapply keys + `superseded` by payment.** When a `kind = 'payment'` message from P exists for the payment, `supplierPaymentUnapply`
  takes the payment / journal / bill keys (`intercompany_allocation_cap_lock`'s set) RIGHT AFTER its payment row lock, the void's order (payment
  row, then keys), then re-reads the undo gate; an unapply racing an accept now waits and is refused. Header N of allocationUndoGate.ts is amended
  for payment messages only (allocation-only payments keep N). `superseded` is keyed on the PAYMENT id: D1 refuses when any ACCEPTED message from
  P with that payload payment id has a `source_doc_id` whose `payment_allocations` row no longer exists, whatever bill it names. Tests: the unapply
  vs accept race (barrier after the accept's keys) ends refused; re-apply to a DIFFERENT bill after a forced row loss answers `superseded`.
- **MED-4 lock census (redone).** Senders D1 / D3: payer journal key (root from P's payment row, unlocked read) -> link FOR SHARE -> connection
  FOR SHARE -> existence -> INSERT; no journal row. Payer void: payment row -> keys -> journal rows. Payer unapply (payment message): payment row
  -> keys. Journal reversal flows: key -> row (unchanged). Receiver accept (P4-D and F) and the 1027 guard: message FOR UPDATE -> keys -> connection
  / link shares -> receipt -> invoices (F's accept service takes the keys BEFORE its UPDATE, as P4-D does, because the guard's own connection
  FOR SHARE at 1027:547 precedes its re-entrant cap lock at 1027:573). Unlink / revoke take the link / connection row only. Every path that holds a key and a link / connection
  lock takes the key first, so no cycle; a D3 loser can no longer be a silent 40P01. Test: D1 and D3 each racing a queued revoke and an accept.
- **MED-2 candidate set and consumption.** Chosen: CONSUMPTION, not one receipt per message. One receipt per message forces the second message
  of a split payment (R200 paid over two bills = two R100 messages; R's bank line is one R200 receipt) into `draft`, which doubles R's cash (R1).
  IX2: DROP 1002's `intercompany_messages_target_uq` and recreate it `... AND kind <> 'payment'`; every other kind keeps one accepted message per
  target (the guard's invoice / allocation checks already query all kinds, and their targets are invoices or contra receipts, which a payment
  message can never target). Unconsumed(receipt) = `total_amount` less the payload amounts of accepted payment messages targeting it, read in the
  guard as its own statement AFTER `SELECT ... FOR UPDATE` of the receipt row (so concurrent accepts serialise). Candidate set: R's receipt,
  customer = the side's, `confirmed`/`reconciled`, non-contra, journal chain odd, `payment_date >= payload date`, not an `IC:` draft of another
  message, unconsumed >= amount, AND (allocated to the message's linked issuer invoice OR unallocated remainder >= amount). `draft` is refused
  (422) while (a) the linked invoice holds an allocation from a candidate receipt, or (b) a candidate's remainder equals the amount exactly. An F
  draft stays bound to its one message (`IC:<m>`). Z3 holds for split payments: each message consumes its own amount, sum <= the receipt's cash.
- **MED-3 cut-over.** The 1025 sender's rule is unchanged (`c.cutover_date`, payment date). D1 uses the same rule; D2 `before_cutover`, H2 and the
  accept service use the same connection `cutover_date` (as 1027's live check), so sender and receiver agree. `intercompany_pair_cutovers` is NOT
  used by F. D1 `no_cutover` / `before_cutover` log warn. The bill date is payload information only.
- **LOW-1** the 1027 system-branch IF exempts `redraft` from the target-change line AND the handled_by / handled_at / handled_via and
  `manual_only` lines; the `redraft` arm then enforces exactly (k) Q1's shape. Test: a redraft changing anything else is 23514.
- **LOW-2** `IC:` is not exclusive (bank flows store bank-line text in `bank_reference`). The "another message's draft" exclusion and the
  receipt's IC chip key on the MESSAGE TARGET (a payment message whose target is this receipt), never on the stamp; the stamp remains only H2's
  draft-branch and confirm gate's binding check (both also require the message to target or name the draft).
- **LOW-3** L-5 is dropped: P4-D allows creator = approver for persons; the ruling is about workers. Optional friction note only (a UI hint).
- **LOW-4** `GET /api/accounting/intercompany/payments/unsent` is `withAuth(withErrorHandler(handler as any))`. A P user without visibility of
  the pair's group gets an explicit state `cannot_determine` (with a sentence), never an empty list.

## (m) Review round 1: binding changes (SUPERSEDE (l) and all earlier text)
- **MED-1 cash only (D1).** D1 refuses `not_cash` (after `through_loan`) when `sp.payment_method = 'contra'` OR no credit line of the payment's
  standing journal (its own, else its batch's) hits a MONEY account of P. Money account = ap/settlementKind.ts's rule: `account_subtype` in
  `CASH_SUBTYPES` (bank, bank_account, cash, cash_on_hand, petty_cash; pinned equal to the TS list by `paymentSqlPins.test.ts`) or an account
  holding imported statement lines (a paycard with no subtype). Why both: `settle_by_contra` writes method `contra` and rides its contra account
  (any balance-sheet account, a bank one included) in the bank column, so the method alone closes the reported path; the money test closes an
  eft captured against a clearing account. Any credit line counts (a batch journal credits the batch bank for every member). Silent in the hook.
- **B5 unsent read** lists only what D1 could still send: never contra / no money credit, `through_loan`, a reversed journal (stricter than D1's
  odd chain: app_user cannot ask the chain), `ambiguous` or `superseded`.
- **LOW-1 / B6 (D2).** `not_cash` between `connection_gone` and `not_enabled`; `closed` (live false) for rejected / dismissed / failed.
- **LOW-2 holders.** "Holders" = R's receipts in the candidate base set (customer, confirmed / reconciled, non-contra, posted unreversed journal,
  dated on or after the payment, not another message's F draft) whose UNCONSUMED amount still covers the payment, candidate or not. The detail
  returns `holderCount` and the first 20 `holders`. While `holderCount > 0` a draft needs `confirmNoHolder: true` with `expected.holderCount` =
  the count the person saw (else 422 `holder_unconfirmed`; a different count 409 `expected_mismatch`). Chosen over a hard block: such a receipt
  is no `existing` candidate (its cash is allocated elsewhere), so a block would leave the message no way forward but reject, and the set grows
  with every later receipt of a regular payer. The exact / linked candidate refusal stays a hard block. Residual R4 in (h).
- **B3 no truncation.** The draft refusal (any exact / linked candidate) and the holder count are computed in SQL over the FULL set; the listed
  receipts order exact, then linked, first before `LIMIT 100`; the invoices order the linked invoice first before `LIMIT 200`.
- **B1** `receipt_short` only for a receipt in the candidate set but for consumption; anything else `receipt_not_candidate`.
- **B2** a held receipt row (existing) or invoice row (draft: 55P03, 40P01, the receipts' typed invoice-lock timeout, a retryable
  ReceiptRefusal) is 409 `busy`, read in its own savepoint; a non-retryable `createCustomerPayment` refusal is 422 `receipt_refused` carrying its
  own sentence (never labelled `exceeds_open`).
- **LOW-3 orphan F draft.** The confirm gate refuses a non-contra draft stamped `IC:<id>` where no payment message to R has that id (it fails
  closed). D4 gives it a way out: no such message, the receipt R's non-contra draft stamped `IC:<p_message>` -> cancelled alone, `(true,
  'orphan')`, no message touched; the service writes the audit row with `orphan: 'true'`; the receipt chip answers status `orphan` and offers
  "Discard draft".
- **LOW-4** reject (final) refuses 403 with R's flag off, before Approve is asked; dismiss / restore stay allowed with the flag off (reversible,
  status only, write role on the route and the 1002 guard). Reject's Approve check lives in `handleService.rejectPayment` (`mayApprove`), pinned
  by `rejectPaymentAuth.test.ts` and `payment-r1-handle.int.test.ts`.
- **B4 / B8 UI.** The detail offers "This is my receipt" / "Draft a receipt" only while the word is `open`; the receipt chip asks
  `receipt-state` only when the nav says the flag is on.
- **Verified, unchanged:** the auto-accept queue (1019 `intercompany_auto_accept_queue`) takes `kind IN ('invoice', 'credit_note')` only; a
  payment message to a side with `auto_accept` on is never queued (`payment-r1-cash.int.test.ts`, with a rolled-back widening as the control).

