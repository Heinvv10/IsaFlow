# Intercompany slice F: the `payment` message and match suggestions on the receiver, 2026-11-24

Parent: docs/plans/2026-11-17-intercompany-mirror-posting.md (rule 3 `cash` mode: "a payment on one side becomes a match suggestion on the
other side's bank line, never a posting"; P4 row: "`payment` message -> match suggestion"). F is the LAST intercompany payment slice. It stacks on
P4-B (1025), P4-C (1026), P4-D (1027), the dark flag (1028), P4-E (1029, its section (j) binding) and P5 (1030, open as #1871 on
`feat/ic-p5-reconciliation-20261124`). The builder branches off master only after P5 merges and re-reads 1027-1030 as merged: F replaces the
1027 messages guard body and the 1025 allocation sender, so a later edit to either on master must be carried into F's bodies.

**Rulings (orchestrator, binding).** Suggestions are READ ONLY. Any accept creates a DRAFT only (a receiver `customer_payments` row with
`status = 'draft'`) or nothing at all; no journal is posted by F anywhere, in either company. Auto-accept, if it ever takes a payment message, creates
drafts only and never confirms (see (j) Q4); a worker never self-approves. No change to `bankAllocationService` (or any bank allocation / bank match
service). A mismatch is STATE on the message (a word a read-only definer answers), never a guess and never a silent pick. Reversals are out of
scope (#1772). A pre-cut-over paired invoice or a locked period is REFUSED, never rolled forward. Everything is behind the dark per-company flag
`intercompany_loan_clearing` (1028, default OFF, fail closed): with the flag off for the payer no `payment` message is written, and with it off for
the receiver none is listed with an Accept, accepted or suggested. F also CLOSES the known gap that app_user can INSERT a `kind = 'payment'` message
directly. Known limits NOT re-reported: #1817, #1833, #1804, #1805, #1808, #1772, #1780, #1781, #1783, #1788, #1760, #1855, #1872.

## (a) What it does
1. **Sender (payer P, CASH connection).** When P's posted cash meets a bill whose supplier is P's side `supplier_id` on an ACTIVE GROUP connection
   whose `settlement_mode = 'cash'`, the database writes ONE `kind = 'payment'` message per `payment_allocations` row for the partner R (the
   issuer). It is written by a new registered definer, `intercompany_send_for_payment(p_allocation uuid)`, from P's own rows only, called by the
   SAME hook sites and the same hook as the allocation message (`mirrorAllocations` in `intercompany/allocationOutbox.ts`, called from
   `applySupplierPaymentPlan`, `processSupplierPayment`, `processBatch`). Each allocation id is offered to both definers in its own savepoint; at
   most one of them writes (section (d)). A loan connection never gets a `payment` message (that is the `allocation` kind's).
2. **Receiver (R), read only.** R's inbox gains a "Payments" list (kind `payment`, R = `to_company_id`). For each message R sees the payload
   (payer's payment number, reference, date, amount, bill number) and a state word from a new receiver-only definer
   `intercompany_payment_message_state(p_message)` (section (b)). The detail shows MATCH SUGGESTIONS computed on request from R's own rows
   only: (i) R's open customer invoices of the side's `customer_id` (the linked issuer invoice first when the bill is in an ACTIVE link), (ii) R's
   confirmed receipts of that customer with an unallocated remainder (the cash R's bank feed already receipted), (iii) R's unmatched incoming bank
   lines (`bank_transactions` of R, `amount > 0`, status `imported`) as a hint only, with no action. Nothing is stored; viewing writes nothing.
3. **Receiver accept (a person in R).** Two outcomes, chosen explicitly:
   - `existing`: "this is my receipt RC-x" (a suggestion of kind (ii)): the message is accepted with target `customer_payment` = that receipt.
     NO document, allocation or journal is written; the receipt stays as it is (its allocations are R's own business through the normal screens).
   - `draft`: "draft a receipt for it": ONE `customer_payments` row, `status = 'draft'`, `payment_method = 'eft'`, `bank_reference = 'IC:<message id>'`,
     `bank_account_id` = a bank account of R the person picks, `payment_date` the person picks, allocated through `customer_payment_allocations`
     to the open invoice(s) the person picks for exactly the payload amount, created through `createCustomerPayment` (ar/customerPaymentService.ts:
     its invoice locks and its open-less-pending-drafts cap apply), then the message is accepted with that draft as target. Confirming the draft
     is R's normal receipt Confirm (`confirmCustomerPayment`) by a person; F adds nothing to it.
   Reject / Dismiss / Restore work as for the other kinds (the existing guard paths).

## (b) Every write, every definer, and the reversal path
**Journals posted by F: NONE, in either company.** Writes:
| write | table / status | by | reversal path |
|---|---|---|---|
| W1 payment message | `intercompany_messages` kind `payment`, `source_doc_type = 'payment_allocation'`, `source_doc_id` = the `payment_allocations.id`, status `pending`, `source_journal_entry_id` = the payment's standing journal (own, else its batch's) | `intercompany_send_for_payment` (owner migration_admin) in P's transaction | none new (#1772). P voids / unapplies the payment with the existing flows: the message is NOT withdrawn; R's state word turns `payer_gone` (state, not a write) and R's Accept refuses. P5-style reporting of it is (h). |
| W2 accept `existing` | the message: `status = 'accepted'`, `target_doc_type = 'customer_payment'`, `target_doc_id` = R's receipt | R's person, app_user UPDATE through the guard | none: an accepted message is final (guard). If R later cancels that receipt (`cancelCustomerPayment`, confirmed receipts only) the state word turns `target_cancelled`. |
| W3 accept `draft` | `customer_payments` (status `draft`) + `customer_payment_allocations` rows, then W2 naming the draft | R's person, app_user, one request transaction | **Gap found: no service discards a DRAFT receipt today** (`cancelCustomerPayment` refuses anything but `confirmed`; no route deletes a draft). F adds `discardIcDraftReceipt` (status `draft` -> `cancelled`, only for a draft stamped `IC:<message id>` whose message R received; its allocations deleted in the same statement set): see (j) Q1. The message stays accepted, state `target_cancelled`. |
| W4 confirm of the draft | NOT F: R's normal Confirm posts DR bank / CR AR as for any receipt | R's person | R's normal receipt cancel. |

New SQL (migration 1031 or the next free prefix: P5 holds 1030; re-check `ls scripts/migrations/sql` and open PRs before every push; forward
only; `SET LOCAL lock_timeout '5s'`; rollback header in the 1025/1027 style naming EXACTLY which earlier statements to restore):
- **D1 `intercompany_send_for_payment(p_allocation uuid) RETURNS TABLE(message_id uuid, reason text, detail text)`**, SECURITY DEFINER, VOLATILE,
  owner migration_admin, `search_path = pg_catalog, public, pg_temp`, REVOKE PUBLIC, GRANT EXECUTE app_user. The 1025 body's shape (tighten-only
  2 s lock bound, `<<main>>` exits, one INSERT ... ON CONFLICT DO NOTHING). Reasons in order: `no_session`, `not_found` (NULL input), `forbidden`
  (`intercompany_user_can_write`), `not_enabled` (P's flag: `company_feature_overrides` row else `feature_flags.is_global`, no plan read, fail closed:
  1029's `receiver_flag_off` rule applied to P), `not_found` (allocation / payment / bill not P's or bill deleted), `not_partner_supplier` (the bill's
  `supplier_id` is not P's side `supplier_id` on a connection of P; connection row FOR SHARE), `no_connection` (not active), `not_group`,
  `not_cash` (`settlement_mode <> 'cash'`), `no_cutover` / `before_cutover` (the PAIR cut-over, `intercompany_pair_cutovers` over P's current
  groups, D/E's rule; both the payment date and the bill date must be on or after it), `not_posted` / `no_journal` (1025's rule: processed or
  reconciled, `COALESCE(sp.gl_journal_entry_id, batch.gl_journal_entry_id)` with odd `intercompany_journal_chain_length`), `through_loan` (that
  journal credits P's side `loan_account_id`: loan territory, never a payment message), then the payer journal key (section (d)), then
  `allocation_sent` (an `allocation` message for this allocation row exists) and `already_sent`. If the bill is in an ACTIVE link (slot
  `intercompany_document_slots`, 1025's join) the link is held FOR SHARE and its issuer `customer_invoice` id goes in the payload; an unlinked bill
  sends `issuerDocument: null`.
  Payload v1 (text through `intercompany_clean_text`, money 2 dp): `{ version:1, kind:'payment', allocationId, amount, currency, payment:{ id,
  number, reference, date, method }, payerDocument:{ type:'supplier_invoice', id, number, date }, issuerDocument:{ type:'customer_invoice', id } |
  null, linkId | null }`. No `cashLegIsLoanAccount` (always false by construction). Non-ZAR is sent; R refuses.
- **D2 `intercompany_payment_message_state(p_message uuid) RETURNS TABLE(live boolean, state text)`**, SECURITY DEFINER, STABLE, no lock, owner
  migration_admin, GRANT app_user. Receiver only: session company = `to_company_id`, signed-in member, `kind = 'payment'`, else
  `(false, 'not_found')`. Words, first wins: `connection_gone` (not active / not group / not one group via `intercompany_shared_group`, NOT the
  VOLATILE `intercompany_in_one_group`), `not_enabled` (R's flag), `future_dated` (payload date after today, Johannesburg), `before_cutover`,
  `payer_gone` (H1 below is false), `link_gone` (payload names a link that is no longer active), `currency`, then for an accepted message
  `target_cancelled` (target receipt status `cancelled`) / `target_ok`, else `open`. One word, no figure, no id, no partner text.
- **H1 `intercompany_payment_payer_standing(p_message uuid) RETURNS boolean`**, STABLE INVOKER, EXECUTE migration_admin only: 1029's
  `intercompany_allocation_payer_standing` body with `m.kind = 'payment'`. (Not a definer; not registered.)
- **H2 `intercompany_payment_target_ok(p_message uuid, p_payload jsonb, p_connection uuid, p_receiver uuid, p_type text, p_id uuid) RETURNS
  boolean`**, STABLE INVOKER, GRANT app_user (the guard calls it as the session, like 1027's `intercompany_allocation_target_ok`). True only when:
  `p_type = 'customer_payment'`, the row is R's (`company_id = p_receiver`), `client_id` = R's side `customer_id`, `payment_method <> 'contra'`
  (an allocation clearing is never a payment target), `total_amount >= payload amount` (2 dp) and EITHER (draft) `status = 'draft'`,
  `bank_reference = 'IC:' || p_message`, `created_by = auth.uid()`, `total_amount` = payload amount, its allocations sum to it and every allocated
  invoice is R's, of that customer, ZAR, open and dated on or after the pair cut-over; OR (existing) `status IN ('confirmed','reconciled')`, its
  journal chain odd, not stamped `IC:` for another message, and its unallocated remainder (total less `customer_payment_allocations`) >= the amount.
- **G1 messages guard** (CREATE OR REPLACE of the 1027 body, every other line unchanged): (1) the GAP: add `'payment'` to the
  `current_user <> 'migration_admin'` refusal list (42501), so only D1 can write a payment message; (2) `intercompany_message_doc_exists` gains a
  `kind = 'payment'` source branch identical to `'allocation'`'s (a `payment_allocation` of the sender's payment), and the guard's source check list
  gains `'payment'`; (3) a target branch `ELSIF NEW.kind = 'payment'`: accepting needs `intercompany_payment_target_ok` (23514 otherwise) and one
  accepted message per target (the existing check + `intercompany_messages_target_uq`); the target changes on no other transition (23514).
  `reject` and `credit_request` stay open to app_user (not F's gap; no writer exists).
- **D3 `intercompany_send_for_allocation`** (CREATE OR REPLACE of the 1025 body): takes the payer journal key at the same point as D1 and refuses
  `payment_sent` when a `payment` message for the allocation row exists. Re-registered (new hash).
- **IX1** `CREATE UNIQUE INDEX IF NOT EXISTS intercompany_messages_one_payment_kind ON intercompany_messages (from_company_id, source_doc_id) WHERE
  source_doc_type = 'payment_allocation' AND kind IN ('allocation','payment')`: the database authority for (d). Pre-check in the migration: zero
  duplicate rows (there can be none: no payment message has ever been written by code), else HALT.

## (c) Refusals
**Sender (D1):** the reason words above; the hook stays silent on every one (as 1025) except `not_found` / `no_journal` (log.error) and
`not_posted` (log.warn); it never throws, so the payment stands. **Receiver accept** (`acceptPaymentMessage`, route `POST
/api/accounting/intercompany/payments/[id]/accept`, `withAuth(withErrorHandler(...))`), ALL from reads before any write, plain 4xx: flag off for R
(403 `not_enabled`, before anything is read); session actor not 'self' (`currentSessionActor`, 403); no intercompany write role or no create right on
customer receipts (403); message not R's / not `payment` (404, one body); status not `pending` (409); D2 state not `open` (409 with its sentence:
`payer_gone`, `link_gone`, `connection_gone`, `future_dated`, `before_cutover`, `currency`); `existing`: receipt not R's / not the side's customer /
contra / cancelled / remainder short / stamped for another message / already a target (422); `draft`: bank account not R's active bank account,
invoice not R's / not the side's customer / not open (AR_OPEN_STATUSES) / not ZAR / dated before the pair cut-over (`pre_cutover_invoice`), amounts
not whole cents or not summing to the payload amount (no partial in F), exceeds open less pending drafts, `payment_date` before the payload payment
date or after today, period with no open fiscal period / locked / VAT-locked (`postingDateRefusal`, allocationClearDate.ts: refused, never rolled
forward); `expected` (amount, state, invoice ids) differs from what the person saw (409). After the first write (the draft) any failure throws a
plain Error: 5xx, the request transaction rolls back (withAuth commits a 4xx).

## (d) Zero double count, vs the P4 allocation message
- **Z1 one message per payer allocation row.** For every `payment_allocations` row a of payer P: count of messages from P with
  `source_doc_type = 'payment_allocation'`, `source_doc_id = a` and `kind IN ('allocation','payment')` is at most 1. Authority: IX1 (a race loser
  gets 23505, which each definer's ON CONFLICT does NOT absorb because the conflict target differs, so each definer checks the other kind first).
  Clean refusal: both D1 and D3, after their link / connection FOR SHARE and BEFORE their existence checks, take the PAYER JOURNAL KEY of the
  payment's standing journal root: `pg_advisory_xact_lock(hashtextextended(P::text || ':journal:' || root::text, 1027))`, root = the chain root of
  `COALESCE(sp.gl_journal_entry_id, batch.gl_journal_entry_id)` walked as in `intercompany/payerJournalKey.ts` (`lockPayerJournalKey`), the same key
  1027's cap lock and the payer undo gate take. Order: link FOR SHARE -> connection FOR SHARE -> payer journal key -> existence check -> INSERT.
  Neither definer locks a journal row, so payerJournalKey.ts's "key, then journal row" order holds; unlink / revoke take the link / connection row
  and no key, so no cycle. The builder still runs a lock-order census of every holder of that key before coding (memory: moving a lock).
- **Z2 modes exclude each other at an instant.** D1 requires `cash`, D3 `loan`, each under the connection FOR SHARE (a mode change is an UPDATE
  of that row and waits). Z1 covers the case across time (a mode change between two events on the same allocation row).
- **Z3 the receiver's AR moves once per message.** A message names at most one target (accepted is final), and a receipt is the target of at most
  one accepted message of ANY kind (`intercompany_messages_target_uq`), so a P4-D clearing receipt (contra, and H2 refuses contra) cannot also
  be a payment target and one receipt cannot absorb two payment messages. `existing` writes no allocation; `draft` allocates exactly the payload
  amount under `createCustomerPayment`'s invoice locks and open-less-pending-drafts cap.
- **Z4 the payer's books.** F writes nothing on P beyond W1: P's AP was cleared by P's own payment, once.
- **Residual (named, not prevented by F):** R confirms an F draft (DR bank) AND later allocates the same bank line through the bank screen as a
  new receipt (DR bank again). The invoice cap stops it when the invoice is fully paid; a second open invoice of the same customer is not
  protected. F mitigates (the `draft` outcome is refused while an `existing` candidate with the exact amount exists: (j) Q2; the draft shows
  "match the bank line to this receipt, do not allocate it again"), and R's bank reconciliation shows the doubled bank debit. See (i) 3.

## (e) Cross-tenant disclosure
- **What R learns** (only through W1's payload, which P's own rows built): P's payment id, number, reference, date, method, amount and currency;
  P's bill id, number and date; the allocation row id; the link id; nothing else of P. This is the allocation payload's set minus
  `cashLegIsLoanAccount`, plus the bill date (to show the cut-over refusal). D2 adds coarse words about P: whether P's payment still stands
  (`payer_gone`) and whether the link still holds. No figure, no id, no partner text beyond the payload.
- **Suggestion scoring reveals nothing about P.** It reads, as app_user under R's RLS: the message row (party_read), R's side, R's
  `customer_invoices`, `customer_payments`, `customer_payment_allocations`, `bank_transactions` and `bank_accounts`. P's rows are never read
  (scores use the payload only: amount, date, reference text against R's invoice numbers / bank descriptions via the pure `scoreAmount` /
  `scoreDate` / `scoreDescription` of bank/bankMatchCandidatesService.ts; the linked issuer invoice id). Suggestions are not stored, so P cannot
  observe that R looked.
- **What P learns back:** the message's status, reject reason and `target_doc_type` / `target_doc_id` (party_read already shows them for every
  kind): that R accepted, and the uuid of R's receipt (an id with no readable content). Accepted limit, same as P2 / P4. P never learns which of
  R's invoices or receipts was suggested or chosen, nor any R figure.
- **Third company C / a user of both:** RLS `party_read` / `sender_insert` / `receiver_update` (1000) unchanged; D1, D2 read
  `app.current_company_id()` only and take no company argument; a user of both P and R in session P sees P's perspective only.

## (f) Definers, 930 registration, grants
Registered in `app_definer_reviews` (930) AFTER create and owner change, `body_md5 = app_definer_hash(fn::regprocedure)`, `writes` naming every
table read / written: **D1** (writes one `intercompany_messages` row; reads `payment_allocations`, `supplier_payments`, `supplier_payment_batches`,
`supplier_invoices`, `gl_journal_entries`, `gl_journal_lines`, `intercompany_document_slots`, `intercompany_document_links` FOR SHARE,
`intercompany_connections` FOR SHARE, `intercompany_connection_sides`, `company_groups` members via the pair cut-over, `feature_flags`,
`company_feature_overrides`, `company_users`; takes one advisory key), **D2** ("nothing (STABLE)": reads the message, connection, sides, links,
flags, the payer standing tail via H1, R's target receipt), **D3** (re-registered, new hash, `writes` + "and a read of payment messages").
INVOKER, not registered: H1 (EXECUTE migration_admin only), H2 (EXECUTE app_user), G1 and `intercompany_message_doc_exists` (body changes; owner
and grants untouched). Deploy-safe grant block as 1027/1029: REVOKE PUBLIC on all; any other role able to EXECUTE gets REVOKEd, a revoke the
migration role cannot make is a WARNING; HALT on PUBLIC execute, app_user missing on D1/D2/H2, app_user having H1, owner not migration_admin,
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
  nothing (flag off for P, loan connection, revoked, external, pre-cut-over payment, pre-cut-over bill, not the partner's supplier, draft / approved
  payment, journal reversed, journal credits the loan account); idempotent re-call and re-process; no session -> silent; viewer `forbidden`; a
  forced definer failure leaves the payment committed.
- **Z1:** same allocation row offered to D1 then D3 and D3 then D1 (mode flipped between, via fixture): one message; two concurrent sessions
  racing D1 and D3 on the same row: one message, the loser answers `allocation_sent` / `payment_sent` (barrier through the sql wrapper after the
  key); IX1 present and refusing a migration_admin-forged second kind.
- **Suggestions:** linked issuer invoice ranked first; unlinked bill ranks by amount/date/reference; pre-cut-over and closed invoices not
  offered; another customer's invoice never offered; C's / P's rows never read (statement log check on a spy); no write (row counts, `updated_at`).
- **Accept:** `existing` writes only the message row; `draft` writes exactly one draft receipt + its allocations and no journal (journal counts
  in both companies unchanged); each (c) refusal writes nothing; R flag off 403 before any read; impersonation 403; expected mismatch 409; locked /
  VAT-locked date refused; a forced guard refusal after the draft insert leaves no draft (5xx rollback); direct app_user UPDATE to `accepted`
  with no target / a contra / another customer's receipt / a P4-D clearing receipt refused 23514; a second message onto the same receipt refused.
- **State words:** payer void -> `payer_gone` and accept refused; unlink -> `link_gone`; revoke -> `connection_gone`; R cancels the target receipt
  -> `target_cancelled`; discard of the F draft -> `target_cancelled`, invoice open amount restored, only an `IC:` draft of a received message
  discardable.
- **Registry / grants:** D1, D2, D3 in `app_definer_reviews` with hash; PUBLIC cannot execute; app_user cannot execute H1; app_pool_reach passes.
Unit: sender reason -> log level; suggestion ranking (pure); refusal order and sentences; payload parse. Component: Payments inbox list, detail
with suggestions, the two accept outcomes, no Accept when the flag is off, state chips. Mutation checks (each must go red): drop `'payment'` from
the guard's migration_admin list; drop D1's `not_cash`, flag, `through_loan`, `allocation_sent` checks; drop D3's `payment_sent`; drop IX1; drop
the key; drop `company_id = R` / customer / contra / status checks in H2; let the draft carry a partial amount; drop `postingDateRefusal`; read
P's rows in suggestions. Browser proof on a throwaway QA company pair (not Demo). Reviews: blind rounds, adversarial ledger review and a
policy-breaker (cross-tenant read, oracle, double count, forged insert) before the queue.

## (h) Not in F
Any journal; confirming the draft (R's normal Confirm); any bank allocation, bank match or `bankAllocationService` change; auto-accept of payment
messages unless (j) Q4 says otherwise; loan-mode non-invoice advances as "loan-movement" suggestions (parent rule 6: their source is a bank line
or a journal, not an allocation row; F2); payments on account (no allocation row); external connections (P6); following reversals or withdrawing a
message on payer void (#1772); FX; partial accepts; storing suggestions; P5 report rows for payment messages (P5b); re-send.

## (i) Ways F could be wrong or leak, and the prevention
1. **Forged payment message by app_user** (today's gap): payload says anything. G1 allow-lists migration_admin for `payment`; test 42501.
2. **Same allocation row as both allocation and payment message** (double clearing + receipt): IX1 + payer journal key + both definers check the
   other kind; race test.
3. **Draft receipt plus bank-line allocation doubles the cash** on R: `existing` preferred, `draft` refused while an exact `existing` candidate
   exists (Q2), invoice cap, warning text; residual named in (d).
4. **Accept auto-picks an invoice** (a guess): no default selection posts; the person picks; auto-accept off for payment in F (Q4).
5. **A P4-D contra clearing receipt reused as a payment target**: H2 refuses `contra`; target_uq.
6. **Pre-cut-over invoice or locked period drafted**: refused in the service AND H2 (cut-over); `postingDateRefusal` before any write.
7. **4xx after the draft insert commits a half accept**: all refusals from reads first; after the first write only 5xx.
8. **Scoring reads P's books** (disclosure): suggestions query R's tables only; a test spies the statements and fails on any P-company table read.
9. **State definer is an oracle on P** (e.g. `payer_gone` for any message id): receiver-session only, `kind = 'payment'`, one `not_found` for
   everything else; tested with C and with P's own session.
10. **Flag off but message still sent or accepted**: D1 checks P's flag in SQL (not only the hook); accept checks R's flag first; D2 answers
    `not_enabled`; list/detail show no Accept. Mutation per check.
11. **Mode flip loan -> cash after an allocation message** sends a payment message for the same row: Z1 (IX1 + `allocation_sent`).
12. **Lock cycle** (deadlock 40P01 with payer void / P4-D cap lock): one order (link, connection, key), no journal row lock in the senders, census
    before coding; tighten-only 2 s bound; a timeout is the hook's logged miss, never a thrown payment.
13. **Stale `existing` receipt** (cancelled or re-allocated between view and accept): H2 re-judges in the guard under the message lock; `expected`.
14. **Draft that can never be discarded** blocks the invoice (pending drafts reduce the open amount): F adds the IC-draft discard (Q1).
15. **Non-ZAR payment matched against a ZAR invoice**: D2 `currency`, accept refused.
16. **Receiver learns the payer's other partners** through the payload text: payload is built by D1 from fixed columns through
    `intercompany_clean_text`; no free payer text beyond reference / number.
17. **Probe suites silently stop testing the guard** once `payment` is closed: every probe moved to `reject` / `credit_request` and a census test
    that each suite still sends at least one message.

## (j) Open questions for the orchestrator (each with a recommendation)
1. **Discarding an F draft receipt.** No service or route discards a draft `customer_payments` row today. Recommend: F adds
   `discardIcDraftReceipt` (draft -> `cancelled`, allocations removed, only an `IC:<message>` draft of a message R received, R's write role), the
   only reversal path F creates; a general draft-receipt discard stays out.
2. **`draft` while a matching receipt exists.** Recommend: refuse `draft` (422 "a receipt for this amount from this customer already exists: link
   it") when an `existing` candidate has the exact amount and remainder; the person can still Reject. A rule on R's own rows, not a guess.
3. **Source row: allocation row vs payment row.** The parent says a payment message's source is the payment row. Recommend the
   `payment_allocations` row (as `allocation`), so Z1 is one unique index and a payment over N bills gives N messages each with its own link.
4. **Auto-accept of payment messages.** Recommend NOT in F: the worker would have to choose an outcome and an invoice; drafts by hand only. If
   wanted later: only state `open`, linked issuer invoice, exact amount, `draft` outcome, never Confirm, through a replaced
   `intercompany_auto_accept_queue`.
5. **Flag semantics on a cash connection.** `intercompany_loan_clearing` names loan clearing; F gates cash-mode messages with it per the ruling.
   Recommend: keep the one flag (no second dark flag), and say so in 1028's flag description in F's migration.
6. **Unlinked bills of the partner's supplier.** Recommend: send them (issuerDocument null, scored suggestions), since cash mode's whole point is
   to match payments the pairing did not link; an unlinked bill dated before the pair cut-over is refused (`before_cutover`).
