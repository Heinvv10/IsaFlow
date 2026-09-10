# R-058 — capture posting routes double-post one captured document

**Severity** HIGH · **Branch** `fix/audit-r058-post-expense-double-post` · **Migration** none

## Trigger

`pages/api/accounting/capture/[id]/post-expense.ts` SELECTed `ce.status` with a
plain read, refused in JavaScript when it equalled `'posted'`, and then created
an expense claim (employee path) or a GL journal (anonymous path) — closing with

```
UPDATE capture_events SET status = 'posted', ... WHERE id = $1 AND company_id = $2
```

carrying **no** `status` predicate and discarding the row count. Two concurrent
requests (a UI double-click, an agent retry) both read `'extracted'`, both passed
the check, and both posted: **one captured receipt, two expense claims or two
journals**.

`capture/[id]/post.ts` — the supplier-invoice sibling, twenty lines of the same
shape — had the identical defect, and its second write is an `INSERT INTO
supplier_invoices`: **one bill accrued twice** against the payable control
account.

`withAuth` COMMITs any response below 500, so the refusal has to happen *before*
the first write, not after it. It does: the claim is taken on the SELECT itself.

## Fix

New `src/modules/accounting/services/capture/captureEventLock.ts` —
`lockCaptureEventForPosting(companyId, eventId)` reads the event joined to its
captured document under `FOR UPDATE OF ce`, behind a re-issued
`SET LOCAL lock_timeout = '5s'`, and refuses to run outside a request
transaction. `55P03` / `40P01` surface as `CaptureEventLockedError`, which both
routes answer as a 409.

Both routes replace their `SELECT ... FROM capture_events` with that call. The
existing `event.event_status === 'posted'` refusal and its 400 wording are
unchanged; nothing else in either file moved.

**Lock, not predicated claim — chosen by measurement.** A predicated
`UPDATE ... WHERE status <> 'posted' RETURNING id` would also serialise, but it
must be written *before* the posting work, which means reordering both handlers
and stamping `posted_by` / `posted_at` / `resolved_*` before the values that
populate them exist. `FOR UPDATE` gets the same outcome with a three-line diff
and is what every other write path in this repo already does
(`bankTxLock.ts`, `creditNoteLock.ts`, `wipEntryLock.ts`, `loanPostingGuards.ts`,
`assets/[assetId]/dispose.ts`, `assets/below-threshold.ts`). Measured: under
READ COMMITTED the loser blocks on the row, re-reads it at the winner's
committed version, sees `'posted'`, and returns 400 having written nothing —
`post-expense: two CONCURRENT requests post ONE journal, not two` proves it by
outcome, and goes red when `FOR UPDATE OF ce` is deleted.

`captured_documents` is joined but deliberately **not** locked: the extraction
pipeline (`captureRouterService.routeEvent`) writes that row.

## Census

Enumerated from the **tables** (every `capture_events` / `captured_documents`
writer in `pages/`, `src/`, `scripts/`), then reconciled **by outcome**: which
sites can write a ledger row, an accrual or a claim more than once for one
captured document. Directories walked: `pages/api/accounting/capture/**`,
`pages/api/accounting/*.ts`, `src/modules/accounting/services/capture/**`,
`src/modules/accounting/services/core/`.

| # | Site | Writes on the second run | Disposition |
|---|---|---|---|
| 1 | `capture/[id]/post-expense.ts` | expense claim + GL journal | **FIXED** — locked |
| 2 | `capture/[id]/post.ts` | `supplier_invoices` INSERT | **FIXED** — locked |
| 3 | `capture/[id]/discard.ts` | `status='discarded'` only | No fix. Check-then-act, but the act is idempotent and posts nothing; a discard racing a post loses the row lock race and the post's stamp wins. Recorded, not registered. |
| 4 | `capture/upload.ts` | INSERT of a NEW event | Out of class — creates, never posts. |
| 5 | `capture/inbound-email.ts` → `inboundEmailService` | INSERT of a NEW event | Out of class. |
| 6 | `capture/whatsapp-inbox.ts` → `whatsAppInboundService` | INSERT of a NEW event | Out of class. |
| 7 | `capture/mirror/**` → `imapMirrorService` | INSERT of a NEW event | Out of class. |
| 8 | `captureRouterService.routeEvent` | `status='extracting'/'extracted'/'failed'` | Out of class — extraction only, posts nothing to the ledger. Note: it can overwrite a `'posted'` status back to `'extracting'` if an extraction is re-kicked after a post; that is a separate, non-financial defect not seen in the wild. |
| 9 | `captureQueryService`, `costCentreUsageGuard` | reads only | Out of class. |
| 10 | `ai-invoice-pipeline.ts` | `supplier_invoices` INSERT | **REGISTERED R-070** — see below |
| 11 | `receipt-to-journal.ts` | GL journal | **REGISTERED R-070** — see below |

`SET status = 'posted'` on `capture_events` appears at exactly three lines in the
repo (post.ts:1, post-expense.ts:2), all of them now behind the lock.

### R-070 (reserved, not fixed here)

`pages/api/accounting/ai-invoice-pipeline.ts:59` and
`pages/api/accounting/receipt-to-journal.ts:43` both `SELECT extracted_data,
status FROM captured_documents` and then **never read `status` again**. They are
keyed on `documentId`, not on a capture event, and have no "already posted"
refusal at all — so they re-post the same captured document on every call, with
no concurrency required. `ai-invoice-pipeline` is partly shielded by
`findDuplicate`; `receipt-to-journal` has nothing.

Registered rather than fixed because the correction is a **new refusal on a
different table**, not the missing lock this item is about: it needs a decision
on whether `captured_documents.status = 'matched'` (or the unused `posted_at`
column) is the right marker, and on whether an operator may legitimately re-run
either route. Neither route has an in-app caller — the full-repo grep for the two
paths finds only docs and build logs — but both are live authenticated endpoints,
so this is a scope judgement, **not** an unreachability argument.

## The guard fails in both directions

- `post-expense: a legitimate first post writes exactly one journal` — 200, one
  journal, event `'posted'`.
- `post-expense: the one journal balances at the receipt total` — 115.00 dr /
  115.00 cr.
- `post: a legitimate first post creates exactly one supplier invoice` — 200.
- `post-expense: an event whose post failed hard is still retryable` — a post
  that 500s (FK violation on a non-existent employee) rolls back with `withAuth`,
  leaves the event `'extracted'` with no claim and no journal, and the retry
  succeeds. The event is never stranded `'posted'` with nothing behind it.

## Tests

`tests/integration/r058-capture-post-double-post.int.test.ts` — 9 tests, all
asserting on OUTCOME (journals / claims / invoices actually written), never on
the wording of a refusal.

| Mutation (file copies, restored) | Result |
|---|---|
| delete `FOR UPDATE OF ce` from `captureEventLock.ts` | 3 failed (the three concurrency tests) |
| `if (event.event_status === 'posted')` → `if (false)` in both routes | 5 failed (both sequential tests + all three concurrency tests) |
| restored | 9 passed |

Two existing unit suites (`postExpenseZeroVatLine.test.ts`,
`capturePostFingerprint.test.ts`) drive the handlers directly with no `withAuth`,
so they now mock `@/lib/als` to stand in a client for the `SET LOCAL`. Their SQL
stubbing is otherwise untouched and all 13 still pass.

## Historical impact — for Hein, production NOT measured

Read-only. Run against production `isaflow` yourself; agents are barred from it.

```sql
-- Capture events posted more than once: one captured document, several
-- ledger artefacts. Any row returned is a double post.
SELECT ce.company_id,
       ce.id                       AS capture_event_id,
       ce.captured_document_id,
       ce.posted_at,
       (SELECT count(*) FROM gl_journal_entries je
         WHERE je.company_id = ce.company_id
           AND je.source_document_id = ce.captured_document_id)      AS journals,
       (SELECT count(*) FROM supplier_invoices si
         WHERE si.company_id = ce.company_id
           AND si.source_document_id = ce.captured_document_id)      AS supplier_invoices,
       (SELECT count(DISTINCT ecl.claim_id) FROM expense_claim_lines ecl
         WHERE ecl.company_id = ce.company_id
           AND ecl.source_document_id = ce.captured_document_id)     AS expense_claims
FROM capture_events ce
WHERE ce.status = 'posted'
  AND ce.captured_document_id IS NOT NULL
  AND ( (SELECT count(*) FROM gl_journal_entries je
          WHERE je.company_id = ce.company_id
            AND je.source_document_id = ce.captured_document_id) > 1
     OR (SELECT count(*) FROM supplier_invoices si
          WHERE si.company_id = ce.company_id
            AND si.source_document_id = ce.captured_document_id) > 1
     OR (SELECT count(DISTINCT ecl.claim_id) FROM expense_claim_lines ecl
          WHERE ecl.company_id = ce.company_id
            AND ecl.source_document_id = ce.captured_document_id) > 1 )
ORDER BY ce.posted_at DESC;

-- Same question asked from the DOCUMENT side, which also catches the R-070
-- routes (they never touch capture_events at all).
SELECT je.company_id, je.source_document_id, count(*) AS journals,
       min(je.entry_date) AS first_entry, max(je.entry_date) AS last_entry
FROM gl_journal_entries je
WHERE je.source_document_id IS NOT NULL
  AND je.source = 'auto_expense_receipt'
GROUP BY je.company_id, je.source_document_id
HAVING count(*) > 1
ORDER BY count(*) DESC;
```

## Not done

- R-070 registered, not fixed (reasoning above).
- `capture/[id]/post.ts` 500s on an extraction with no `lineItems` / `warnings`
  array (`aiInvoicePipelineService.ts:142,179` read `.length` unguarded). Found
  while seeding the fixture; pre-existing, unrelated to this item, left alone.
- Item 8 above: `routeEvent` can move a `'posted'` event back to `'extracting'`.
  Non-financial; recorded, not registered.
