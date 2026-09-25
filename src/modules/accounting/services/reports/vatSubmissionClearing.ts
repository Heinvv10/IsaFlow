/**
 * The ONE marker of `vatSubmissionService`'s clearing journal (V-05).
 *
 * Filing a VAT201 through `vatSubmissionService` posts a settlement journal on
 * day 1 of the FOLLOWING period — DR VAT Output / CR VAT Input / the net to
 * accrued — with this source. It settles the previous return and is no supply,
 * so every reader that sums VAT control lines for a return, lock, export, recon
 * or exception must leave it out, or the period after a filing reads the
 * previous period's tax as its own (and the recon, uncoded list and exceptions
 * report two permanent rows per filed period).
 *
 * Bound as a PARAMETER — `je.source IS DISTINCT FROM ${VAT_SUBMISSION_CLEARING_SOURCE}`
 * — not spliced as a nested `sql` fragment, so it adds no call to a
 * positionally mocked `sql` in the unit suite. IS DISTINCT FROM, never `<>`:
 * `source` is nullable and NULL <> x is NULL, which would drop every
 * NULL-source journal. tests/unit/guards/vatSubmissionClearingCensus.test.ts
 * fails when a VAT-summing reader lacks it.
 */
export const VAT_SUBMISSION_CLEARING_SOURCE = 'auto_vat_submission';
