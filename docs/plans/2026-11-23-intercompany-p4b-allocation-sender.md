# Intercompany P4-B: the allocation sender (outbox only), 2026-11-23

Parent: docs/plans/2026-11-17-intercompany-mirror-posting.md (P4 row, RULING 2026-11-21). Slice A is PR #1776 (contra-settle posting service). B writes the payer's `allocation` message and nothing else: **no ledger writes, no receiver behaviour.** C/D (receiver draft clearing, loan contra-settle) and E (`payment` match suggestions) come later.

Binding rulings (orchestrator, 2026-11-22): (1) auto-accept creates drafts only and never counts as approval; (2) `bankAllocationService` unchanged, loan clearing is a separate contra journal in D; (3) a mismatch is a state on the message; (4) reversals out (#1772); (5) the receiver refuses a pre-cutover paired invoice or locked VAT period with the reason stored on the message (C/D's job: the sender cannot read the receiver's books).

All open questions below were decided with the recommended answer (orchestrator-conservative).

## (a) What emits, and where
- Event: the PAYER (P) applies posted cash to one of its own supplier invoices (bills). The bill is one side of an ACTIVE `intercompany_document_links` row whose other side is the issuer's (I) `customer_invoice`; the link's connection is `active` and `settlement_mode='loan'`. Direction P to I. One message per allocation row.
- The live AP table is `payment_allocations` (201: id, payment_id, invoice_id, amount_allocated, UNIQUE(payment_id, invoice_id); no company_id). `supplier_payment_allocations` has zero rows and no writer: ignore it.
- Sites: EMIT at `applySupplierPaymentPlan` (ap/supplierPaymentApplicationService.ts, after the status UPDATE; the INSERT gains `RETURNING id`; all six callers go through it); EMIT also at `processSupplierPayment` (supplierPaymentWorkflowService.ts) and `processBatch` (batchPaymentService.ts), after each final status write, for that payment's (or each member payment's) allocation ids, because the loan-mode clearing on the payer is `settle_by_contra` AP (create, approve, process) and never reaches the apply function. The definer's eligibility (posted, linked, loan) makes extra calls harmless.
- SKIP: `createSupplierPayment` and `createBatch` inserts (drafts), all AR sites (`applyReceiptPlan`, `customerPaymentService`, `gatewayInvoiceReceiptService`), demo seed. Deletes (unapply, bank unwind) are reversals (#1772).

## (b) Message identity
`kind='allocation'`, `source_doc_type='payment_allocation'`, `source_doc_id` = the `payment_allocations.id` row. The existing UNIQUE(from_company_id, source_doc_type, source_doc_id, kind) plus `ON CONFLICT DO NOTHING` makes a retry, a second hook call or a re-process a no-op (`already_sent`). One payment over N bills gives N messages.

## (c) Payload: built by the database only
New registered definer `intercompany_send_for_allocation(p_allocation uuid) RETURNS TABLE(message_id uuid, reason text, detail text)`, modelled on `intercompany_send_for_source` (1019). The app names the row id and nothing else; the messages guard refuses any session-written allocation message.
Checks, session company P = `app.current_company_id()` (round 1 of review: the write role is asked FIRST, so a user who may not send learns nothing about a row, link or connection; the rest cheapest first):
-1. no session (a NULL session company, or no signed-in user: `auth.uid()` NULL) answers `no_session` before any row is looked at;
0. `intercompany_user_can_write(P)`, else `forbidden`;
1. allocation row exists, its `supplier_payments.company_id = P` and `supplier_invoices.company_id = P`, bill not deleted, else `not_found`;
2. the bill's slot in `intercompany_document_slots` (P, 'supplier_invoice', id) has a link `status='active'`, other side `customer_invoice`, other company = the connection's partner, else `no_link`;
3. connection active (`no_connection`) and loan mode (`not_loan`);
4. `cutover_date` set (`no_cutover`) and `payment_date >= cutover_date` (`before_cutover`);
5. (moved to 0);
6. payment processed/reconciled (a NULL status is neither: `not_posted`) with a posted standing journal: `COALESCE(sp.gl_journal_entry_id, batch.gl_journal_entry_id)` with odd `intercompany_journal_chain_length`, else `not_posted` / `no_journal`;
7. existing message, else `already_sent`;
8. build payload, INSERT ... ON CONFLICT DO NOTHING; record the journal in `source_journal_entry_id`; `group_transaction_id` NULL.

Payload v1 (text through `intercompany_clean_text`, money 2 dp): `{ version:1, kind:'allocation', allocationId, amount, currency, payment:{ id, number, reference, date, method, cashLegIsLoanAccount }, payerDocument:{ type:'supplier_invoice', id, number }, issuerDocument:{ type:'customer_invoice', id }, linkId, linkOrigin }`. `cashLegIsLoanAccount` = the JOURNAL the message stands on has a credit line on the payer side's `loan_account_id` (D needs it to avoid double counting). Read from the journal, not from a document column: a batch member's own `bank_account_id`, a provisional settlement's bank account and the batch's are not what the ledger credited. The issuer document number is not sent (the sender never reads the receiver's books). Non-ZAR is still sent; the receiver refuses.

## (d) Migration (prefix: the next free one, re-check `ls scripts/migrations/sql` and open PRs at implementation time; forward only, `SET LOCAL lock_timeout '5s'`)
1. Messages guard (CREATE OR REPLACE of the 1019 body): add `'allocation'` to the migration_admin allow-list branch and `'payment_allocation'` to its source_doc_type list; add `'allocation'` to the `intercompany_message_doc_exists(... 'source' ...)` check on INSERT. UPDATE path unchanged (allocation creates no document, target cleared).
2. `intercompany_message_doc_exists` (INVOKER): new branch kind `allocation`, role `source`: type `payment_allocation` and the row exists joined to `supplier_payments` with `company_id = p_company`. Role `target` stays false.
3. The definer: OWNER migration_admin, `search_path = pg_catalog, public, pg_temp`, tighten-only 2 s lock timeout restored at every exit (1019 pattern), REVOKE ALL FROM PUBLIC, GRANT EXECUTE to app_user only.
4. 930 registry: `app_definer_reviews` row written AFTER create and owner change, hash from `app_definer_hash(...)`; header carries rollback lines.
5. A DO block raises if PUBLIC can execute the definer.
No change: the kind CHECK already allows `allocation`; inbox, auto-accept queue and `loadInboxRow` filter `kind IN ('invoice','credit_note')` so allocation messages are invisible to the receiver.

## (e) Hook (best effort)
New `intercompany/allocationOutbox.ts`: `mirrorAllocations(companyId, allocationIds)` on the caller's transaction; each id in its own `withSavepoint('intercompany_allocation', ...)`; never throws; logs SQLSTATE only; `no_journal` and `not_found` (an id the caller just read under its own company is always a bug) log at ERROR, `not_posted` at WARN (nothing re-sends; P5 lists unsent allocations); `forbidden` (a user without an intercompany write role pays bills all day), `no_session`, `no_link` / `not_loan` / `no_connection` and the other answers silent.

**Payments applied outside a request send no allocation message.** A caller with no session (the categorization sweep, `llmCategorizationPass` under `withAlsTransaction`: no `app.current_company_id`, no `request.jwt.claims`) reaches `applySupplierPaymentPlan` -> the hook, the definer answers `no_session` and the hook stays silent. Nothing re-sends; P5 lists linked loan bills paid without a message.

## (f) Tests
Integration (`tests/integration/intercompany/allocation-*.int.test.ts`, two tenants plus a third, as app_user): one message P to I with payload equal to P's rows; idempotent re-call and re-process; cash connection, unlinked bill, pending/unlinked link, revoked connection, pre-cutover payment, draft/approved payment emit nothing with the named reason; cross-tenant (P naming I's or C's allocation row gives `not_found`; a user of both in session P naming I's row refused; C sees nothing); forged: app_user INSERT of kind `allocation` refused 42501 (update `messages-documents.int.test.ts:76`, which asserts `ok` today) and a definer-planted allocation naming a made-up or foreign row refused; viewer `forbidden`; a forced definer failure leaves the application committed; apply, process and processBatch each emit; receiver inbox count/list and auto-accept never see an allocation; registry and app_pool_reach checks pass and PUBLIC cannot execute. Fixture: `plantMessage` (intercompany.plant.ts) must plant a real allocation row for kind `allocation`.
Unit: `applySupplierPaymentPlan` calls the hook with the returned ids after the status write.
Mutation checks: drop the guard's allocation branch; drop the loan check; drop the active-link check; drop `company_id = P` on payment or bill; drop ON CONFLICT; drop the hook's savepoint or catch; loosen the lock timeout; register without the hash.

## (g) Not in B
Any receiver behaviour (draft clearing, accept/reject of allocations, the pre-cutover and VAT-lock refusals, mismatch state); any journal or contra settle; the `payment` kind and cash-mode match suggestions (E); reversals (#1772); AR-side emission; credit-note allocations; UI, outbox view, P5 reconciliation and re-send; any change to `bankAllocationService`; closing app_user INSERT of kinds other than `allocation` (`payment` stays open: about ten suites use it as a generic probe; E closes it).

## Decided questions
- Hook `processSupplierPayment` and `processBatch` too: yes.
- Unlinked bill: emits nothing; P5 lists linked-supplier bills paid without a link (or C/D adds an `issuerDocument:null` variant later).
- Cut-over gate: `payment_date >= connection.cutover_date`; a pre-cutover paired bill paid after cut-over IS sent and the receiver refuses (ruling 5).
- Receiver accept of an allocation message stays as is (no route reaches it); C/D decides.
- A link confirmed later does not back-emit earlier allocations (P5 reports them).
- A payment applied outside a request (no session) sends nothing (`no_session`, silent); P5 lists it.
- The definer reads the link and connection rows `FOR SHARE` (a revoke / unlink in flight is waited for under the 2 s bound, then judged as it stands). Those row locks last until the CALLER'S transaction ends (they survive the savepoint release and span every member of a processed batch), not until the definer returns. Taking them only on the path that goes on to INSERT (and re-checking) is a possible refinement; not done.
- The link alone is enough (links are authoritative); the payload carries enough for D to re-check.
- `cashLegIsLoanAccount` is in the payload.
