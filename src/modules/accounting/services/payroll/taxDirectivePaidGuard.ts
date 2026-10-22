/**
 * What paid a SARS tax directive, for refusing to cancel it (PAYE 4a
 * follow-ups G5, Hein 2026-10-22: a paid directive cannot be cancelled;
 * reverse the payment first). "Paid" is the directive's one
 * tax_directive_payments row (UNIQUE (company_id, tax_directive_id), migration
 * 403), of either kind, while the journal that books it stands:
 * - a payroll run's claim (payroll_run_id, migration 901), booked by the run's
 *   journal: it stands while that journal is in force (an approved or paid
 *   run's journal cannot be reversed; a reopened run keeps it until someone
 *   reverses it);
 * - a stand-alone payment (applyTaxDirective), booked by its own journal: it
 *   stands while that journal is in force. The same rule decides what is
 *   declared (directivePaymentFiling).
 * "In force" is the reversal chain's NET in the ledger (payrollJournalInForce):
 * a reversal can itself be reversed, so `reversed_at` alone cannot say.
 * Reversing the journal is the way back in both cases, as #752 established for
 * a reopened run: reverse, cancel, recalculate, approve, and the approval
 * releases the claim.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { payrollJournalInForce } from './payrollJournalChain';

/** A route answers this with 409. Raised before anything is written. */
export class TaxDirectivePaidError extends Error {
  readonly code = 'TAX_DIRECTIVE_PAID';
  constructor(readonly directiveId: string, message: string) {
    super(message);
    this.name = 'TaxDirectivePaidError';
  }
}

/** Why the directive cannot leave 'approved', naming what paid it and the way back; null when unpaid. */
export async function directivePaidBy(companyId: string, directiveId: string, directiveNumber: unknown): Promise<string | null> {
  const rows = (await sql`
    SELECT tdp.payment_date, tdp.payroll_run_id, h.period_year, h.period_month, h.status AS run_status,
           COALESCE(tdp.journal_entry_id, h.journal_entry_id) AS journal_id,
           COALESCE(je.entry_number, rje.entry_number) AS entry_number
    FROM tax_directive_payments tdp
    LEFT JOIN payroll_run_headers h ON h.id = tdp.payroll_run_id AND h.company_id = tdp.company_id
    LEFT JOIN gl_journal_entries rje ON rje.id = h.journal_entry_id AND rje.company_id = tdp.company_id
    LEFT JOIN gl_journal_entries je ON je.id = tdp.journal_entry_id AND je.company_id = tdp.company_id
    WHERE tdp.company_id = ${companyId}::uuid AND tdp.tax_directive_id = ${directiveId}::uuid
    LIMIT 1
  `) as DbRow[];
  const p = rows[0];
  if (!p) return null;
  // No journal: none committed books it (a stand-alone payment links its journal in the same transaction).
  if (p.journal_id == null || !(await payrollJournalInForce(companyId, String(p.journal_id)))) return null;
  const which = `SARS directive ${directiveNumber == null ? directiveId : String(directiveNumber)}`;
  const journal = p.entry_number == null ? 'its journal' : `journal ${String(p.entry_number)}`;
  if (p.payroll_run_id != null) {
    const period = `${String(p.period_year)}-${String(p.period_month).padStart(2, '0')}`;
    return `${which} is paid by the payroll run ${period} (${String(p.run_status)}), so it stays approved. `
      + `To cancel it, reopen that run and reverse ${journal}; then cancel the directive, recalculate the run and `
      + 'approve it, which releases the directive.';
  }
  return `${which} was paid outside payroll on ${fmtDate(p.payment_date)}, so it stays approved: the payment is `
    + `declared to SARS under it. To cancel it, reverse ${journal} first.`;
}

/**
 * A stand-alone payment whose journal has been reversed is undone (and its
 * reversal can no longer be reversed: payrollJournalReversalGuard), so its row
 * no longer pays the directive: delete it, freeing the directive's one payment
 * row (UNIQUE, migration 403) for a new payment. The reversed journals stay in
 * the ledger. Called by applyTaxDirective under its FOR SHARE on the directive.
 */
export async function releaseReversedStandalonePayment(companyId: string, directiveId: string): Promise<void> {
  const rows = (await sql`
    SELECT id, journal_entry_id FROM tax_directive_payments
    WHERE company_id = ${companyId}::uuid AND tax_directive_id = ${directiveId}::uuid
      AND payroll_run_id IS NULL AND journal_entry_id IS NOT NULL
  `) as DbRow[];
  const p = rows[0];
  if (!p || await payrollJournalInForce(companyId, String(p.journal_entry_id))) return;
  await sql`DELETE FROM tax_directive_payments WHERE id = ${p.id}::uuid AND company_id = ${companyId}::uuid`;
  log.info('Reversed directive payment released', { companyId, directiveId, paymentId: String(p.id) }, 'taxDirective');
}
