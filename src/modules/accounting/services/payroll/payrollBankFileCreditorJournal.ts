/**
 * Confirming a salary bank file that paid garnishee creditors clears their payable in the GL (wave 7 GC2, W12 part 2;
 * Hein's ruling 5; grill F13; migration 1057). Called by settleBankFile under the file's lock.
 *
 * The journal (one per file; payroll_bank_files.creditor_journal_id is unique and 1057's guard refuses a confirm of a
 * file with creditor lines that does not name it, posted, with debits equal to those lines):
 *   DR each garnishee payable the file's orders credit (payroll_garnishee_orders.payable_account_id), by account
 *   CR the account the run's net pay was credited to by the run's own payroll journal (the bank-role holder, or the
 *      net-pay clearing account: payrollJournalBank.ts). With a clearing account, the bank line the file produces is
 *      allocated against that account for the file's whole total, so the clearing account nets to nil once.
 * Dated the file's action date (the day the bank pays), source auto_payroll (as UIF and directive payments are),
 * source_record_id = the file. Amounts are what the FILE paid each creditor (its items), never a recomputation.
 *
 * judgeCreditorConfirm decides everything before the first write (spec rule 12; a 4xx commits):
 *   CREDITOR_AMOUNT_DIFFERS   a creditor line is not the run's CURRENTLY APPLIED deduction for its order (a reopened run, or
 *                             one approved again with other deductions): refused, never attestable.
 *   CREDITOR_DETAILS_CHANGED  an order's creditor_bank_set_at is not the one snapshotted on its line (GC1 design input):
 *                             the details changed since the file was built. If it was not sent: void it and generate
 *                             again. If the bank already paid it as built, the confirm says so (paidAsGenerated), and
 *                             the audit row records the attestation; the file's lines show where the money went.
 *   PERIOD_CLOSED             the action date falls in a closed or locked fiscal period, or a closed or locked fiscal
 *                             year (F13a), named.
 *   JOURNAL_NOT_POSTED        the run has no posted payroll journal of its own crediting net pay (no account to credit).
 *   CREDITORS_NOT_PAYABLE     a payable or the net-pay account is inactive: the post would refuse after a write.
 * Not reversed by a reopen (the bank paid); its own reversal is refused (payrollJournalReversalGuard): a confirmed file
 * is final, so the payment it records is too. A re-approval of the run that would deduct one of these orders a different
 * amount is refused (payrollBankFileReapproval), so the order's balance always counts what the creditor was paid.
 *
 * THE JUDGE -> POST WINDOW. settleBankFile holds the run's bank-file advisory lock and the file row (FOR UPDATE) from
 * before this judge to its commit, so no other confirm, void or generate of the file interleaves. What is NOT locked:
 *   - the order's creditor details: an edit committed after the judge read them does not change what is posted (the
 *     journal posts the amounts the file paid, from its items), and the file's lines keep the account as paid;
 *   - the fiscal period: a close committed in the window is caught by postJournalEntry's own period check; the draft
 *     it leaves is deleted (postCreditorJournal) before the refusal propagates, so a 4xx commits no draft journal;
 *   - the accounts' active flag: the same, by postJournalEntry's inactive-account refusal.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { cleanUpAfter } from '@/modules/accounting/services/gl/reversalCleanup';
import { ClosedFiscalPeriodError, InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { NET_PAY_CLEARING_DESCRIPTION, NET_PAY_DESCRIPTION } from './payrollLabourComparison';
import { runJournalDescriptionOf } from './payrollJournalDescription';
import { PayrollBankFileRefusal } from './payrollBankFileStatus';
import { formatCents } from '@/lib/money/formatMoney';

export interface CreditorPosting {
  entryDate: string;
  description: string;
  lines: Array<{ glAccountId: string; debit: number; credit: number; description: string }>;
  totalCents: number;
  /** Orders whose details changed since the file was built, confirmed under the paidAsGenerated attestation. */
  attestedChanged: string[];
}

const LINE = 'Garnishee creditors paid by salary bank file';

/** Null when the file pays no creditor (nothing to post). Read-only; refuses with a PayrollBankFileRefusal. */
export async function judgeCreditorConfirm(opts: {
  companyId: string; runId: string; fileId: string; paidAsGenerated: boolean;
}): Promise<CreditorPosting | null> {
  const { companyId, runId, fileId } = opts;
  const items = (await sql`
    SELECT i.amount_cents::text AS cents, o.creditor_name, e.employee_number, o.payable_account_id::text AS payable,
           (o.creditor_bank_set_at IS DISTINCT FROM i.creditor_bank_set_at) AS changed,
           a.is_active AS payable_active, f.action_date::text AS action_date,
           COALESCE((SELECT round(d.amount * 100)::bigint FROM payroll_garnishee_deductions d
                      WHERE d.run_id = f.run_id AND d.order_id = i.garnishee_order_id AND d.company_id = i.company_id
                        AND d.balance_applied), 0)::text AS applied_cents
      FROM payroll_bank_file_items i
      JOIN payroll_bank_files f ON f.id = i.file_id AND f.company_id = i.company_id
      JOIN payroll_garnishee_orders o ON o.id = i.garnishee_order_id AND o.company_id = i.company_id
      JOIN payroll_employees e ON e.id = i.employee_id AND e.company_id = i.company_id
      JOIN gl_accounts a ON a.id = o.payable_account_id AND a.company_id = o.company_id
     WHERE i.file_id = ${fileId}::uuid AND i.company_id = ${companyId}::uuid AND i.garnishee_order_id IS NOT NULL
     ORDER BY o.kind, o.priority, o.created_at, o.id
  `) as DbRow[];
  if (items.length === 0) return null;
  const label = (r: DbRow) => `${String(r.creditor_name)} (employee ${String(r.employee_number)})`;

  // Security review on #1929 (the other ordering of the breaker's HIGH): a file generated, the run reopened and approved
  // again with another deduction, THEN the old file confirmed would record a creditor payment the order's balance never
  // counts. Each creditor line must equal the run's CURRENTLY APPLIED deduction for its order (a reopened run applies
  // none). Remedy: approve the run with deductions equal to what the file paid (payrollBankFileReapproval holds that
  // from then on), then confirm. Holds even under paidAsGenerated: that attests the account, not the amount.
  const differ = items.filter((r) => String(r.cents) !== String(r.applied_cents));
  if (differ.length > 0) {
    const named = differ.map((r) => `${label(r)}: the file paid ${formatCents(Number(r.cents))}, the run now applies ${formatCents(Number(r.applied_cents))}`);
    throw new PayrollBankFileRefusal('CREDITOR_AMOUNT_DIFFERS',
      `The file's garnishee payments no longer match the run's approved deductions (${named.join('; ')}). Confirming it would pay `
      + 'the creditor an amount the order\'s balance does not count. Approve the run so each deduction equals what the file paid, then confirm it.',
      named);
  }

  const changed = items.filter((r) => r.changed === true).map(label);
  if (changed.length > 0 && !opts.paidAsGenerated) {
    throw new PayrollBankFileRefusal('CREDITOR_DETAILS_CHANGED',
      `The creditor bank details changed after this file was made, for ${changed.join(', ')}. If the file was not sent, void it `
      + 'and generate it again. If the bank already paid it as it was made, confirm it saying so: the file records the account it paid.',
      changed);
  }

  const entryDate = String(items[0]!.action_date);
  const closed = (await sql`
    SELECT period_name AS name FROM fiscal_periods
     WHERE company_id = ${companyId}::uuid AND start_date <= ${entryDate}::date AND end_date >= ${entryDate}::date
       AND status IN ('closed', 'locked')
    UNION ALL
    SELECT 'FY' || fiscal_year::text FROM fiscal_years
     WHERE company_id = ${companyId}::uuid AND start_date <= ${entryDate}::date AND end_date >= ${entryDate}::date
       AND status IN ('closed', 'locked')
     LIMIT 1
  `) as DbRow[];
  if (closed[0]) {
    throw new PayrollBankFileRefusal('PERIOD_CLOSED',
      `The file's action date ${entryDate} falls in the closed fiscal period ${String(closed[0].name)}, so the payment to the garnishee `
      + 'creditors cannot be posted there. Reopen that period, then confirm the file.');
  }

  const run = ((await sql`
    SELECT period_year, period_month, pay_frequency, run_kind, off_cycle_reason, run_date, period_end
      FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  // The run's latest posted journal of its own (a reversal is described "Reversal of …", so never matched).
  const net = run ? ((await sql`
    SELECT jl.gl_account_id::text AS id, a.is_active
      FROM gl_journal_entries je
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
      JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = je.company_id
     WHERE je.company_id = ${companyId}::uuid AND je.source = 'auto_payroll' AND je.status = 'posted'
       AND je.description = ${runJournalDescriptionOf(run)} AND je.reversal_of_id IS NULL AND je.reversed_at IS NULL
       AND jl.credit > 0 AND jl.description IN (${NET_PAY_DESCRIPTION}, ${NET_PAY_CLEARING_DESCRIPTION})
     ORDER BY je.posted_at DESC NULLS LAST, je.created_at DESC
     LIMIT 1
  `) as DbRow[])[0] : undefined;
  if (!net) {
    throw new PayrollBankFileRefusal('JOURNAL_NOT_POSTED',
      'This run has no posted payroll journal of its own in force crediting net pay (never posted, or reversed), so there is no '
      + 'account to pay the garnishee creditors from. Approve the run again to post its journal, then confirm the file.');
  }
  if (net.is_active !== true || items.some((r) => r.payable_active !== true)) {
    throw new PayrollBankFileRefusal('CREDITORS_NOT_PAYABLE',
      'The net-pay account or the garnishee payable account is deactivated, so the payment to the creditors cannot be posted. '
      + 'Activate it in the chart of accounts, then confirm the file.');
  }

  const byPayable = new Map<string, number>();
  for (const r of items) byPayable.set(String(r.payable), (byPayable.get(String(r.payable)) ?? 0) + Number(r.cents));
  const totalCents = [...byPayable.values()].reduce((s, c) => s + c, 0);
  const period = `${String(run!.period_year)}-${String(run!.period_month).padStart(2, '0')}`;
  return {
    entryDate, totalCents, attestedChanged: changed, description: `${LINE}, payroll ${period}`,
    lines: [
      ...[...byPayable].map(([glAccountId, cents]) => ({ glAccountId, debit: cents / 100, credit: 0, description: LINE })),
      { glAccountId: String(net.id), debit: 0, credit: totalCents / 100, description: LINE },
    ],
  };
}

/** Posts the judged journal (after every refusal). Returns its id, for the file's creditor_journal_id. */
export async function postCreditorJournal(companyId: string, fileId: string, posting: CreditorPosting, userId: string): Promise<string> {
  const entry = await createJournalEntry(companyId, {
    entryDate: posting.entryDate, description: posting.description, source: 'auto_payroll', sourceRecordId: fileId, lines: posting.lines,
  }, userId);
  try {
    await postJournalEntry(companyId, entry.id, userId);
  } catch (err) {
    // A refusal in the judge -> post window (a period closed, an account deactivated) is a 4xx, which commits: the draft
    // must not survive it. `status = 'draft'` keeps this from ever touching a posted journal.
    await cleanUpAfter(err, () => sql`
      DELETE FROM gl_journal_entries WHERE id = ${entry.id}::uuid AND company_id = ${companyId}::uuid AND status = 'draft'`);
    // The two refusals the window can meet answer as the judge's own would (409), not as a fault.
    if (err instanceof ClosedFiscalPeriodError) {
      throw new PayrollBankFileRefusal('PERIOD_CLOSED',
        `The fiscal period of the file's action date ${posting.entryDate} was closed while the file was being confirmed (${err.periodStatus}). Reopen that period, then confirm the file.`);
    }
    if (err instanceof InactiveAccountError) {
      throw new PayrollBankFileRefusal('CREDITORS_NOT_PAYABLE', `${err.message} Then confirm the file.`);
    }
    throw err;
  }
  return entry.id;
}
