# R-169: ai-invoice-pipeline never marks its capture event posted, and never records real coding

Sibling of R-131/R-160. Noted, not fixed, in `docs/audits/remediation/R-160/fix.md` ("Not in scope
(noticed)"): "The pipeline never marks the document's `capture_events` row posted... `recordCoding`
still records `glAccountId: null` for pipeline bills."

## What was found (branch base origin/master 66e776d81)

Reading `pages/api/accounting/ai-invoice-pipeline.ts` on the branch base: the route writes
`captured_documents` (`matched_invoice_id`, `status = 'matched'`) but never touches
`capture_events` at all — no `SELECT`, no `UPDATE`, no import of anything in
`captureEventLock.ts`. Its sibling, `capture/[id]/post` (via
`capturePostFollowUps.runCapturePostFollowUps`), stamps the event `status = 'posted',
posted_by, posted_at, updated_at` right after posting. A document reached through the
pipeline — email, WhatsApp, or IMAP/Gmail/M365 mirror ingestion, all of which create a
`capture_events` row — keeps showing `Extracted` in `/accounting/capture/inbox` forever,
even though it was already turned into a bill. The document itself cannot be posted twice
(`captured_documents.posted_at` is the real fence, R-131/R-160), so this is a display/inbox
defect, not a double-posting one — but an operator working the inbox has no way to tell a
pipeline-posted document from one still awaiting review.

Separately, `recordCoding` was called unconditionally with `glAccountId: null, vatCode: null,
costCentreId: null, projectId: null` — even on a request where `planCaptureBillLines` had just
coded the bill's own lines from a real supplier coding rule (`getRule(companyId,
supplierMatch.supplierId)`, computed one line above and thrown away). `capture/[id]/post`'s
`capturePostFollowUps` passes the SAME rule's fields (`codingRule?.defaultGlAccountId ?? null`,
etc.) into its own `recordCoding` call. So the two routes, posting the same shape of bill from
the same rule, recorded differently: one taught the learning loop, the other never did.

**A false lead, ruled out by reading `supplierRulesService.recordCoding`'s own comment:**
"AI-pipeline postings arrive with null glAccountId and intentionally don't seed a rule with no
coding content." That comment is about the branch where NO rule exists yet
(`rule === null`) — it is deliberate policy that an AI posting must never seed a brand-new
coding rule from its own unverified guess (a self-reinforcing loop with no human check). It says
nothing about the case where a rule ALREADY exists (necessarily seeded by an earlier HUMAN
correction, per that same file) and the pipeline's own lines were just coded from it — passing
that existing rule's account through is not a new self-taught rule, it is recording what already
happened, exactly as `capture/[id]/post`'s `auto_publish` path already does. So the fix mirrors
`capture/[id]/post`'s existing, decided contract; it does not "fix" recordCoding's null-seeding
policy, which stays exactly as it was.

## Reproduction

No separate script run: the mutation table below (M1, M5) reverts the two touched blocks to
exactly what was on the branch base, and both go red on the exact assertions this finding
predicts (event stays `extracted`; coding history is `gl_account_id: null` even though a rule
exists). That is the reproduction, run in place of a duplicate no-op script.

## Fix

- **`src/modules/accounting/services/capture/captureRowLock.ts`**: new
  `lockPostableCaptureEventIds(companyId, documentId)`. `ai-invoice-pipeline` is the one posting
  route that reaches a document directly and carries no event id of its own — every other
  poster gets one from the URL. It locks (`FOR UPDATE`, the module's 5s `lock_timeout` pattern)
  every `capture_events` row tied to the document, **alongside the document lock, before any
  ledger write** (document-then-event, the module's own order), and returns only the ids still
  `isCaptureEventPostable` (`received`, `extracting`, `extracted`, `failed` — never `discarded`
  or already `posted`). A document with no capture event at all (an upload straight through
  `/accounting/capture`) returns an empty array.
- **`pages/api/accounting/ai-invoice-pipeline.ts`**:
  - Locks the postable event ids right after the document lock (same `CaptureRowLockTimeoutError`
    handling as the document lock already had).
  - After the invoice, its lines, and the document link (the same point
    `capturePostFollowUps` stamps its own event id — after every write that could make the
    request fail, before every write that follows only on success), stamps those ids
    `status = 'posted', posted_by, posted_at, updated_at` — a no-op when the array is empty.
  - `getRule(companyId, supplierMatch.supplierId)` is now kept in a `codingRule` variable
    (previously computed inline and discarded) and reused for `recordCoding`:
    `glAccountId: codingRule?.defaultGlAccountId ?? null`,
    `vatCode: codingRule?.defaultVatCode ?? extracted.vendorVatNumber ?? null`,
    `costCentreId: codingRule?.defaultCostCentreId ?? null`,
    `projectId: codingRule?.defaultProjectId ?? null` — the exact fields
    `capturePostFollowUps` passes for `capture/[id]/post`'s `auto_publish` case. No rule → every
    field but `vatCode` stays null, `vatCode` falls through to the extracted vendor VAT number
    (same fallback), and — because `entry.glAccountId` is still null — `recordCoding`'s
    no-rule-yet branch still seeds nothing from the pipeline's own guess, unchanged.
- **`src/modules/accounting/services/capture/supplierRulesService.ts`**: reworded the "AI-pipeline
  postings arrive with null glAccountId" comment — it stays null only when there is genuinely no
  rule to reuse; it no longer claims to be always null, since it now isn't.

File-size note: `ai-invoice-pipeline.ts` sits at exactly 300 lines (the repo cap) after this
change; comments were kept terse to fit.

## Gates that still hold

- `claimCapturedDocumentForPosting` (the real posting fence, `captured_documents.posted_at`),
  `planCaptureBillLines`/`insertCaptureBillLines` (R-131/R-160), `attachEvidenceAndSettleApproved`
  with `postUnattached: true` (R-160): all unchanged, same order. The only addition is the event
  lock (read-only) alongside the document lock, and the event UPDATE + the `recordCoding` field
  change after the document link.
- The event lock adds NO new deadlock risk: it is taken in the module's existing document-then-
  event order, and it is the only writer taking a NEW row (no other code path in this route
  already held a `capture_events` lock).

## Tests (real PG, through the route, app_user with withAuth GUCs)

`tests/integration/r169-pipeline-capture-event-coding.int.test.ts`, fixture `isaflow-fixture-r169-goal`
(cloned from the live `isaflow-fixture-r159` container). No migration needed for this fix — the
branch's own migrations top out at 716.

**Fixture schema contamination, disclosed:** the clone's `schema_migrations` tops out at
`717_paystack_request_portal_link.sql` — R-167's own migration (`paystack_payment_requests
.portal_payment_link_id`), from the still-unmerged branch `fix/r167-link-charges-link-amount-20260930`
(commit `bfee49e57`), not from master or this branch. `isaflow-fixture-r159` is a live container
another session owns and may write to over time; cloning it picks up whatever schema state it is
in at that moment, not a frozen R-159 snapshot. None of this fix's tests touch `paystack_*` tables
or columns, so nothing here depends on migration 717 — same shape as
`feedback_shared_fixture_db_schema_contamination` in memory.

| Test | Proves |
|---|---|
| an auto-approved run marks the tied capture event posted | `status='posted'`, `posted_by` = the caller, `posted_at` set |
| a 4xx refusal leaves the tied capture event unchanged | a total-≤0 400 (R-160's own refusal) touches nothing on the event |
| a document with no capture event at all is unaffected — the update is a no-op | 200, no error, from an empty locked-ids array |
| a discarded event is left discarded, not resurrected to posted | `isCaptureEventPostable` filter holds even though the document itself still posts |
| only the tied event is marked — an unrelated event in the same company, and another company's event, stay untouched | document + company scoping of the lock query |
| the coding history carries the supplier rule's account, not the pipeline's own guess | `gl_account_id` = the rule's account; `vat_code` falls through to the vendor VAT number (the rule has none of its own) |
| no rule: the coding history stays uncoded on the GL account, but carries the vendor VAT number, and no rule is seeded | the existing intentional-null path is unchanged |

Run together with the R-160/R-131/R-127/R-035-PR2/K-072/R-058/R-107/R-088/R-032-L5 suites listed
as this fix's precedents (28 files, `--no-file-parallelism`): **267 passed, 0 failed.**

## Mutation table

Each mutation was applied to the working file, the named test(s) run, then the file restored
from a `cp` backup (`cmp` checked equal after restore).

| # | Guard removed | Named test | Red on |
|---|---|---|---|
| M1 | the whole "mark capture events posted" block deleted | an auto-approved run marks the tied capture event posted; only the tied event is marked… | `expected 'extracted' to be 'posted'` (both) |
| M2 | the event UPDATE moved to fire unconditionally right after the lock (before every refusal branch) | a 4xx refusal leaves the tied capture event unchanged | `expected 'posted' to be 'extracted'` |
| M3 | `isCaptureEventPostable` filter removed from `lockPostableCaptureEventIds` (returns every row regardless of status) | a discarded event is left discarded, not resurrected to posted | `expected 'posted' to be 'discarded'` |
| M4 | `company_id` predicate dropped from the final `UPDATE capture_events` (kept only `id = ANY(...)`) | — | **stays green**: the ids in the array were already scoped to this company by the earlier lock query (`WHERE captured_document_id = $1 AND company_id = $2`), a second, independent layer, same shape as R-131's M7/R-160's M8 |
| M5 | `recordCoding`'s `glAccountId` reverted to a literal `null` | the coding history carries the supplier rule's account… | `expected { gl_account_id: null, … } to match object { …, gl_account_id: '<ruleGl>', … }` |
| M6 | `vatCode` reverted to `codingRule?.defaultVatCode ?? null` (fallback to `extracted.vendorVatNumber` removed) | the coding history carries…; no rule: the coding history stays uncoded… | `expected { vat_code: null } to match { vat_code: '4123456789' }` (both) |

## Browser proof (dev, Brightsphere, reporting-qa@isaflow.dev)

The pipeline has no button in the app — same as R-160 found; only this route and the e2e smoke
tests reference it. **Deviation from the brief, disclosed:** the seed document/event were not
created through normal app use — they were inserted with a direct `psql` connection to
`isaflow_dev` as the `postgres` superuser (the `DATABASE_URL` in `.env.local`), bypassing
`withAuth`/RLS entirely, rather than through a real upload + VLM OCR pass. Everything AFTER that
seed — the pipeline call, the invoice, its journal, the coding history row — was written by the
real route, authenticated as reporting-qa, exactly as intended. The dev server ran from this
worktree on :3282; the session was minted for reporting-qa via GoTrue `admin/generate_link` →
`email_otp` → `/verify`, and the route was called from the signed-in page with `fetch` plus the
`isaflow_csrf` header, exactly as R-160 did, from a headless Playwright script with its own
browser context (not the shared Chrome profile / MCP browser).

- `browser-inbox-before-extracted.png`: `/accounting/capture/inbox`, the seeded row
  (`billing@ventureworkspace.example`, 2026/09/30 12:44) at the top, status **Extracted**.
- `browser-inbox-after-posted.png`: same page, reloaded after the pipeline answered 200
  (`auto_approve`, invoice `VW-R169-2703` approved) — the row is **gone** from the default
  (pending-only) view; the three pre-existing R-160/R-131 rows are unaffected.

### Dev writes (Brightsphere, `d27bac33-cdc0-4e58-bf6b-709c1597d41c`) — nothing deleted

**Seeded directly (as `postgres`, not through the app):**

| Table | id | Notes |
|---|---|---|
| `captured_documents` | `420715d5-8b73-4f58-9965-c5ef4695a9e3` | `status='pending'`, `extracted_data` a realistic JSON blob (Venture Workspace, ref `VW-R169-2703`, total 736.00, VAT 96.00, no line items), `file_name='r169-proof.pdf'` |
| `capture_events` | `bbd8e09b-2f5e-44df-bd96-8fa38060a148` | `channel='email'`, `status='extracted'` (its initial value), `captured_document_id` → the row above, `sender='billing@ventureworkspace.example'` |

**Written by the pipeline run (through the real route, as reporting-qa, `posted_by` = the
reporting-qa GoTrue user id `233f3bd5-9f54-45bb-9b88-a9389ce0c8f3`):**

| Table | id | Notes |
|---|---|---|
| `capture_events` (update) | `bbd8e09b-2f5e-44df-bd96-8fa38060a148` | `status → 'posted'`, `posted_by`, `posted_at` set — this fix's own change |
| `captured_documents` (update) | `420715d5-8b73-4f58-9965-c5ef4695a9e3` | `status → 'matched'`, `posted_at` set, `matched_invoice_id` → the invoice below |
| `supplier_invoices` | `3f2f972f-9057-4d60-a1dc-4ff64448bae0` | `invoice_number='VW-R169-2703'`, `status='approved'`, `total_amount=736.00`, `posting_agent='ai:ai-invoice-pipeline:v1'`, `gl_journal_entry_id` → the journal below |
| `supplier_invoice_items` | `33b17c47-81a4-4228-99fa-b57b9fe97ff5` | one line, `'As per invoice'`, 640.00 + 96.00 VAT |
| `gl_journal_entries` | `c896e853-9583-453c-9fe1-f224cc2b3d04` | `entry_number='JE-2027-00006'`, `source='auto_supplier_invoice'`, `status='posted'`, dated 2027-03-10 |
| `gl_journal_lines` | 3 rows (`39a74d1c…`, `59e3aefe…`, `ca9cde05…`) | DR 640.00 expense, DR 96.00 VAT input, CR 736.00 accounts payable — balanced |
| `supplier_coding_history` | `ebfad287-bffb-4368-a70d-cec102465202` | `gl_account_id: null` (Venture Workspace has no coding rule on dev), `vat_code='4240294944'` (Venture Workspace's own VAT number, via `extracted.vendorVatNumber` — the intentional-null path and the VAT fallback both exercised in the same run), `posted_by='ai:ai-invoice-pipeline:v1'` |

`performThreeWayMatch` and `resolvePendingAlertForInvoice` also ran (best-effort, part of the
route) but wrote nothing: no linked PO, and no pending expectation alert existed for this
supplier — confirmed `SELECT count(*) FROM expected_invoice_alerts WHERE resolved_invoice_id =
'3f2f972f-…'` = 0.

Everything above is left in place, same as R-160/R-131 left their dev writes — one approved bill,
one posted journal, one coding-history row. No migrations.

## Historical data

`census.sql` is READ ONLY, for Hein to run on prod; it was never run there.
1. `capture_events` still not `posted` whose document has a bill the pipeline posted, per
   company.
2. The detail rows for query 1.
3. Overall count of pipeline coding-history rows with a null vs. a real GL account.
4. Pipeline coding-history rows with a null GL account where a supplier coding rule with an
   account exists TODAY for that supplier (an approximation — the rule may have changed since
   posting) — summary and detail.

No repair is proposed: this fix only changes what a FUTURE pipeline run records and marks; it
does not reconstruct what an earlier run would have recorded had the fix already been live.
