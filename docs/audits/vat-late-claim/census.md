# VAT late input claim — reader census (Task 0)

2026-09-25, branch `feat/vat-late-input-claim-20260925` at `4faf25ed7`.

Question: when a posting dated in a locked VAT period P is split (original keeps
expense/AP lines, input VAT moves to the clearing account, every line's
`vat_type` is NULLed; companion dated in P+1 posts DR `vat_input` (original
`vat_type`) / CR clearing), which readers change, and do any break the VAT201
or a statutory figure?

Method: `grep vat_type` across `src/` + `pages/` intersected with
`gl_journal_lines`, plus the readers the plan named (eFiling gate, capture VAT
evidence, exception queries). Each read at the SQL.

## Verdict: STOP — two readers break the P+1 filing

### B1. `reports/vatExceptionsService.getVatExceptions` → `sarsEfilingSubmissionService.evaluateEfilingGate` (BLOCKS FILING)

`controlRecon` compares `generateVAT201(...).field10_totalInputVAT` — built from
`supplier_invoices`/`supplier_invoice_items` **by `si.invoice_date`** — with
`findVatControlMovement` (GL movement on `vat_input`/`vat_output`, by
`je.entry_date`). After a split:

- P+1: GL input includes the companion's X; the document population does not
  include the bill (its `invoice_date` is in P). `inputVariance = −X` →
  `reconExceptions = 1` → `totalExceptions > 0` → `evaluateEfilingGate` returns
  `allowed: false` → `submitVAT201ToSars` throws `EfilingBlockedError`. **Every
  late claim blocks the ISV filing of the period it is claimed in.**
- P: the reverse (+X); P is already filed, but its exception report is no longer
  clean.

Query 5 (supplier invoice ↔ GL input VAT mismatch) also fires: it joins
`supplier_invoices.gl_journal_entry_id` = the ORIGINAL, which after the split
has no `vat_input` line, so `gl_vat = 0` against `tax_amount = X` — one
`invoiceGlMismatches` row, dated P (so it blocks a re-file of P, not P+1).

Without the feature neither arises: the bill cannot be approved inside the lock,
and the workaround (date it in P+1) keeps document and journal in one period.

### B2. `reports/vat201LedgerFields.getLedgerVAT201` field 8 (STATUTORY FIELD SPLIT)

`field8_services` comes from `generateVAT201` (`supplier_invoice_items.vat_classification`
by `si.invoice_date`); `field7_otherGoods = field10 − field6 − field8 − field9`.
For a late-claimed bill classified `services`: P+1's field 10 includes X, field 8
does not, so field 7 is overstated by X and field 8 understated by X in the
return filed for P+1 (field 10 and field 11 are right). This is the figure set
`sars-vat201.ts` renders and `sarsEfilingSubmissionService` files.

### Proposed handling for B1/B2 (needs a decision — not in the brief)

Date a late-claimed bill's document-derived VAT by its companion:
`COALESCE(companion.entry_date, si.invoice_date)` in the three supplier queries
of `generateVAT201` and in `vatExceptionsService` queries 5 and 7, and in query 5
sum `vat_input` over the original AND its companion
(`gl_journal_entries.late_claim_of_id = si.gl_journal_entry_id`). That makes
P+1's document population, recon and field 8 carry the bill, and P's drop it.
Consequence to accept: P's regenerated document-derived figures change after the
split (P is filed; `draftDrift` on P's saved draft would report drift if P is
ever re-submitted). The alternative — leave the readers and document "clear the
exception by hand" — leaves the eFiling gate unpassable for P+1 without an
override, which the gate does not have.

## Needs handling, not statutory

### N1. `reports/vatNonSupplyExceptions.findVatNonSupplyLines` (a control goes blind)

Flags a line carrying a claiming `vat_type` on an account whose NAME matches the
non-supply pattern (salaries, donations, …). NULLing the base line's `vat_type`
removes the original from this check in P, and the companion has no line on the
non-supply account, so input VAT claimed late against a non-supply account is
never flagged in either period. `classifyVatJournalLine` calls such a line
`base`, so the split planner would accept it. Proposed: `qualifiesForLateClaim`
refuses when a base line with a claiming `vat_type` sits on an account matching
`NON_SUPPLY_PATTERN` or with `vat_input_denied = true` (plain lock refusal, as
today). Decision needed on whether that is a new refusal reason.

### N2. `bank/bankTxQueryFragments` `POSTED_VAT_LATERAL` and `reports/vatAllocationMismatchService`

Both derive a bank transaction's VAT code from the PRESENCE of a
`vat_input`/`vat_output` line in the matched journal. A user-initiated bank
allocation that is split has none (its tax line moved to the clearing account),
so the bank screen shows "No VAT" and the mismatch report raises
`displayed_differs` for a transaction that did claim input tax (in P+1).
Proposed: count subtype `vat_input_late_claim` as input VAT in both `IN` lists.
Display and exception only; no figure.

## Changes, no handling needed

| Reader | Effect of the split | Why it is correct |
|---|---|---|
| `reports/vatBoxBasisQuery` + `vatBoxBasis.deriveVatBoxes` (the VAT201 and the lock snapshot) | Original is no longer VAT-bearing (no control line, no tag) → out of P. Companion is a member of P+1. | P unchanged is the point. The companion's clearing line would be `base` with −X and break box 15's check — handled by the planned `late_claim` role (Task 3). |
| `reports/vatEntryMembership` / `gl/vatLockLineClassification` | Original not a member of P → a later account reclass touching its lines inside P's lock is allowed. | It moves no filed figure. |
| `reports/vatReturnService.getVATReturn` → `vatSubmissionService` clearing journal | Reads control-account lines only (`IN ('vat_input','vat_output','tax')`). Companion's `vat_input` line carries the original `vat_type` → P+1 box. Clearing account (asset, `vat_input_late_claim`) not selected. | Same box, later period. |
| `reports/vatControlMovement` | Control subtypes only; companion counted in P+1, clearing excluded. | Consistent with the VAT201. |
| `reports/vatReconciliationService` | Reads `vat_type` on control lines only (capital-goods split). Companion carries it. | Unchanged box. |
| `vatExceptionsService` query 1 (uncoded control lines) | Companion carries the original tax line's `vat_type`; an originally-NULL one is flagged in P+1 instead of P. | Same finding, claim period. |
| `reports/vatBalanceSheetExceptions` | A tagged line on a no-treatment BS account is `unmapped` → the split refuses (plain lock refusal), so nothing is hidden. Clearing lines carry no tag. | — |
| `reports/vat201NilRatedSupplies` | Reads `account_type = 'revenue'` lines only; the split refuses any tagged revenue line; `untaxed_documents` are customer documents. | Untouched. |
| `reports/vat201Service` customer side | Reads `jl.vat_type` of customer-invoice journals — output, never split. | Untouched. |
| `gl/reclassification/partition` | The original's NULL-tag expense line is no longer skipped as `vat_period_locked`. | No filed or future figure moves; reclassing the clearing account itself is a system-account question for Task 2 (verify the reserved-subtype guard covers it). |
| `capture/capturedVatEvidence`, `capture/provisionalPostingService`, `capture/pettyCashJournalService` | Pre-post writers/guards over input lines; unattended paths are not opted in. | Untouched. |
| `expense/claimVatAdvice` | Reads claim lines, writes `'no_vat'` for denials (not VAT-moving). | Untouched. |
| `reports/customReportFieldDefs` (`jl.vat_type` column), journal detail UI | Show a blank VAT type on the original's lines. | Cosmetic; the companion shows the code. |

## Decisions (Hein, 2026-09-25)

1. **B1/B2 — date by companion.** For a bill whose approval journal has a posted
   late-claim companion (`late_claim_of_id`), `generateVAT201`'s supplier and
   field-8 queries and pre-filing exceptions 5 and 7 date that bill's VAT by the
   companion's `entry_date`, so it counts in the claim period. Exception 5
   compares the bill's VAT against the original plus its companion. Tests: P+1
   has zero exceptions and `evaluateEfilingGate` allows it; fields 7/8 correct
   for a late-claimed services bill; P's invoice-based figures equal those
   before the late bill existed.
2. **N1 — refuse.** The split refuses (today's lock refusal, reason
   `non_supply` on `VatLateClaimRefusal`) when any VAT-coded expense line sits on
   a non-supply account or one with `vat_input_denied`.
3. **N2 — fix.** `vat_input_late_claim` counts as input VAT in the bank-screen
   lateral and the allocation-mismatch query.
