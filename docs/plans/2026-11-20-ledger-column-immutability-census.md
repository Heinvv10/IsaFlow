# Ledger column immutability: writer census (2026-11-20)

Scope: who writes `gl_journal_entries.{status, source, description, reversal_of_id, entry_date, company_id}`,
`gl_journal_lines` on posted entries, and `customer_invoices` / `supplier_invoices` / `credit_notes`
`.{status, gl_journal_entry_id}`. Method: regex over `src pages packages scripts` (SQL text, multi-line SET lists,
aliases), every migration, and the demo reseed; then each hit read. Test fixtures run as the fixture superuser
(`is_superuser = on`) and are not production writers. Reproducible with the two scripts' logic: an `UPDATE <table> ... SET`
match whose SET list names the column.

Existing guards this builds on: 999n (posted journal lines frozen; entry leaves posted only to reversed; posted
payroll header/journal-link state rules; deferred balance checks), `ux_gl_je_reversal_of` (619: one contra per
original), 865/862/712 (approval gates on `status`), 871 (FX gate). All of them are STATE rules that bind every
non-superuser session, never a rule on `current_user` (a role check is beaten by `set_config('role', ...)`).

## 1. `gl_journal_entries`

| Column | Production writers after INSERT | Notes |
|---|---|---|
| `reversal_of_id` | **1**: `gl/journalEntryPostingService.ts:240` (`UPDATE ... SET reversal_of_id` on the contra, AFTER `postJournalEntry`, same transaction as the claim) | No INSERT in src or pages sets it (checked by statement parse). Only `scripts/repairs/2026-07-05-p1-1-...ts` (one-off, already run) inserts it. Readers: ~60 (chain walks); none write. |
| `reversed_at`, `reversed_by` | `gl/journalEntryReversalClaim.ts:114` (claim: NULL -> set), `:158` (release: set -> NULL, only after the contra draft was deleted) | Release must never fire once a contra links to it. |
| `source` | none after INSERT | INSERT sites: `journalEntryCrudService.ts:106` (`createJournalEntry`, ~60 callers pass `source`), `yearEndJournalPoster.ts:201`, `assetDepreciationPosting.ts:130`. |
| `description` | none after INSERT | Historical one-off migrations only (523/524/908, already applied). |
| `entry_date` | none after INSERT | same |
| `company_id` | none | already frozen once posted by 999n. |
| `status` | `journalEntryPostService.ts:77` (draft -> posted), `customerInvoiceGlPosting.ts:179` (historical import, draft -> posted), `sageMigrationCommitService.ts:279` (draft -> posted) | all draft -> posted; 999n rule 3 already freezes posted/reversed. |
| other (not in scope, listed for completeness) | `evidenceAttachmentService:129`, `provisionalEvidenceAttach:165` (`source_document_id`), `externalRefService:188` (`external_*`), `vatLateClaimSplit:125` (`late_claim_of_id`), `manualJournalApproval:107/166`, `manualJournalAuthors:69` (approval stamps), `provisionalPostingService:183` | untouched. |
| scripts | `fixes/backfill-je-fiscal-periods.ts:120` (`fiscal_period_id`), `fixes/repair-reversed-journal-status.ts:211` (retired by 999n), `backfill-auto-postings.ts`, `seed-historical-data.mjs`, `import-sage-britech.ts`, `stress-test.ts`, `large-scale-seed.ts`, `qa-*` | operator / seed scripts; none of them write the frozen columns of a POSTED row except the retired repair and the one-off reversal repair. |

SQL functions that write these tables: none on a request path (only historical migrations 206, 220, 252, 479, 523,
524, 908, which run before any guard exists on a fresh build).

Demo reseed (`scripts/lib/demoReseed`): bulk INSERTs journals already posted, with no `reversal_of_id`. **Correction
(review round 2):** the first census wrongly said it inserts documents unlinked; `generateSales.ts:84` and
`generatePurchases.ts:76` set `gl_journal_entry_id` on the INSERT, which 1018 refuses to a non-superuser (production's
reseed runs as a NOSUPERUSER `postgres`). The reseed now inserts the documents unlinked and links them after the
journals exist (`run.ts` + `write.ts linkDocumentJournals`). Its wipe deletes the lines of Demo journals, which stay
exempt (rule 6, the Demo company's literal id, as in 999n).

## 2. `gl_journal_lines` on posted journals

Already closed by 999n (debit, credit, journal and company frozen; line set fixed after posting unless born in the
same transaction). Writers that remain legitimate and are untouched: `accountMergeService:77`
(`gl_account_id`), `vatLateClaimSplit:93/98/206/251` (`gl_account_id`, `vat_type`, `late_claim_base`),
`dimensionTagApply:100/174` (dimensions), `yearEndJournalPoster:215`, `assetDepreciationPosting:144/149`,
`journalEntryCrudService:125` (born in the transaction). Nothing new needed.

## 3. Documents

`gl_journal_entry_id` writers (all in src; every one links a journal it posted earlier in the SAME transaction):

| Site | Transition |
|---|---|
| `ar/customerInvoiceGlPosting.ts:196` (approve) | NULL -> posted journal |
| `ap/supplierInvoiceWorkflowService.ts:156` (approve), `:275` (backfill/post-to-GL) | NULL -> posted journal |
| `ar/creditNoteApproveService.ts:234` | NULL -> posted journal |
| `core/migrationImportService.ts:235`, `ap/migrationApService.ts:237` (take-on) | NULL -> posted journal |
| `admin/sageMigrationCommitService.ts:281` | NULL -> posted journal |
| `ar/customerInvoiceCancelService.ts:166`, `ap/supplierInvoiceWorkflowService.ts:342` (cancel) | journal -> NULL, AFTER the chain head was reversed (O.reversed_at set) |
| scripts `backfill-auto-postings.ts:202/282` | NULL -> posted journal |

No INSERT of a document sets `gl_journal_entry_id` (parsed all 20 INSERT sites in src/pages/scripts). Nothing moves
journal A -> journal B. Nothing but the two cancel paths clears a link. `creditNoteCancelService` reverses the journal
and KEEPS the link.

`status` writers: 30 UPDATE sites in 17 files (approve x3, cancel x4, payment/allocation x6, recompute x3,
credit-note apply/unapply x5, provisional withdraw, 'sent' stamp, imports). Payment flows move
approved <-> partially_paid <-> paid by `amount_paid` arithmetic and are legitimately many; rewriting those into
definer calls is out of the question (30 sites). A state rule needs no rewrite. The state couplings that hold in
every writer: a document is never cancelled while its linked journal is posted and un-reversed.

Not coupled (so no state rule is safe): draft/pending -> approved without a link. AR approve writes `status` BEFORE it
posts and links; AP can approve a bill with a NULL link (provisional bank-first, legacy rows); a DRAFT bill can already
carry a link ("Post to GL" action). A deferred "approved implies link" check would break these.

## 4. What the database can and cannot decide

Provenance ("this row was written by the posting service") is not visible to Postgres: the posting services and an
injected statement are the same login, the same role, the same GUCs. A flag set by the service
(`set_config('app.posting', ...)`) is set by the attacker the same way (memory: runtime-role guard beaten by
set_config; only REVOKE holds). A SECURITY DEFINER wrapper only moves the question to "who may call it", and the
answer is the same role. So:

* **Closable (state rules, no writer changes):** the reversal link (exact-negation, same company, posted, acyclic,
  immutable once set, none on INSERT); the posted journal's `source`/`description`/`entry_date`; `reversed_at`
  cleared only when no contra links to it; a document's journal link (NULL -> a posted, un-reversed, un-linked
  journal of its own company, none on INSERT; cleared or moved only when the old journal is reversed); a document
  moving to `cancelled` while its journal is in force.
* **Not closable in the database (reported, not built):** INSERT of a journal with an arbitrary `source` /
  `description` (3 INSERT sites, but `createJournalEntry` serves ~60 callers and the forged caller is the same role);
  a draft/pending document set to `approved` with a NULL link; an `approved` document linked to a journal an attacker
  posted himself with the right `source`. The first two only a privilege split (a separate posting role) can close,
  which is a design decision for the planner tier; the consumer that trusts `source` should instead trust the
  document-to-journal link and the chain, which the rules above make sound.

## 5. Decision against the stop condition

The change needs 0 writer rewrites (all rules are triggers over state the writers already produce). The reversal
rule touches the payroll chain and VAT late-claim reversal paths only as a CHECK on their contra (their contra is
the same debit/credit swap every reversal uses; `reversalLines.ts`); the integration suites for those paths are in
the verification list. Proceeding to build.
