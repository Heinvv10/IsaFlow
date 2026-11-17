/**
 * What generateSalaryBankFile judges before it writes anything (wave 6 BF; split out of payrollBankFileService.ts).
 * Read-only. Each judge throws a PayrollBankFileRefusal naming what to fix.
 *
 *   judgeExistingFiles  a confirmed file = the bank has paid (BANK_HAS_PAID); a generated file of the current approval =
 *                       already made (FILE_EXISTS); a generated file of an ENDED approval (the run was reopened) is
 *                       UNSETTLED_FILE: it may have been uploaded, so a person must confirm it or void it with the
 *                       "not sent to the bank" attestation first. Never voided by the generator (review #1524 BRK-4).
 *   payingAccount       the company's bank-role holder (the account the payroll journal credits), with a valid number.
 *   readPayments        the run's lines with each employee's active bank details. Refused: details that became active
 *                       after the approval (BRK-2/D-2: COALESCE(activated_at, created_at), activated_at stamped by the
 *                       999h trigger on insert and on re-activation, so neither a new row nor a re-activated old one
 *                       slips past, whether or not changes are written as new rows), missing or invalid details, negative net. Nil
 *                       net pay is left out of the file and named in the warnings (coordinator ruling, review #1524).
 *   judgeApprovedTotals fail closed (BRK-3, D-1): the run must link a posted, unreversed journal of ITS OWN (source
 *                       'auto_payroll' and payrollRunJournalDescription of the run's period, the one definition the
 *                       journal plan uses; a header repointed at another run's journal is refused) with net-pay lines
 *                       (JOURNAL_NOT_POSTED otherwise: post it first), and the lines must sum to both the header's
 *                       total_net and that journal's net-pay credit. The header alone is no anchor: app_user can move it
 *                       with the lines. The journal binds against ROUTED writers only: raw-SQL forging or editing of a
 *                       posted journal as app_user (review #1524 E-1/E-2) is a residual closed by wave-6 PR FZ
 *                       (posted gl_journal_lines immutability and the insert-as-posted balance gap).
 *
 * RESIDUAL (security review (b), coordinator ruling C): the anchors are TOTALS. Nothing records each employee's net at
 * approval (the plan hash and the R-035 digest cover journal lines aggregated by account and CC1; the journal has one
 * net-pay line), so net moved between employees with the total unchanged is not caught here. What holds today is this
 * total anchor plus the run's R-035 approval. The structural fix is wave-6 PR FZ: a database trigger refusing
 * money-column changes on an approved run's lines and header (after PS3).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { validateBankAccount } from '@/modules/accounting/services/ap/eftService';
import { resolveBankRoleHolder } from '@/modules/accounting/services/gl/bankRoleHolder';
import { salaryReference, type AcbAccount, type AcbAccountType, type AcbPayment } from './payrollAcbFile';
import { NET_PAY_CLEARING_DESCRIPTION, NET_PAY_DESCRIPTION } from './payrollLabourComparison';
import { payrollRunJournalDescription } from './payrollJournalDescription';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import { PayrollBankFileRefusal } from './payrollBankFileStatus';

const ACB_TYPES: ReadonlySet<string> = new Set<AcbAccountType>(['cheque', 'savings', 'transmission']);
const rand = (cents: number): string => `R${(cents / 100).toFixed(2)}`;

export async function judgeExistingFiles(companyId: string, runId: string): Promise<void> {
  const live = (await sql`
    SELECT f.id, f.status, f.sha256, f.total_cents::text AS total_cents, f.action_date::text AS action_date,
           f.run_approved_at = COALESCE(h.approved_at, h.approval_grandfathered_at) AS current
      FROM payroll_bank_files f JOIN payroll_run_headers h ON h.id = f.run_id AND h.company_id = f.company_id
     WHERE f.company_id = ${companyId}::uuid AND f.run_id = ${runId}::uuid AND f.status IN ('generated', 'confirmed')
  `) as DbRow[];
  if (live.some((f) => f.status === 'confirmed')) {
    throw new PayrollBankFileRefusal('BANK_HAS_PAID',
      'The bank has paid this run: its salary bank file was confirmed. A second file would pay everyone again; pay any difference separately.');
  }
  const f = live[0];
  if (!f) return;
  const file = { id: String(f.id), sha256: String(f.sha256), totalCents: Number(f.total_cents), actionDate: String(f.action_date) };
  if (f.current === true) {
    throw new PayrollBankFileRefusal('FILE_EXISTS', 'A salary bank file was already generated for this run. Void it before generating another.', [], file);
  }
  throw new PayrollBankFileRefusal('UNSETTLED_FILE',
    `An earlier salary bank file for this run (${rand(file.totalCents)}, action date ${file.actionDate}, sha256 ${file.sha256.slice(0, 12)}…) `
    + 'was made before the run was reopened and may already be at the bank. If the bank paid it, record that it was accepted; '
    + 'if it was never sent, void it saying so. Then generate again.', [], file);
}

export async function payingAccount(companyId: string): Promise<AcbAccount> {
  const holder = await resolveBankRoleHolder(companyId);
  if (!holder.account) throw new PayrollBankFileRefusal('NO_PAYING_ACCOUNT', holder.refusal.detail);
  const row = ((await sql`
    SELECT bank_account_number, bank_branch_code FROM gl_accounts
     WHERE id = ${holder.account.id}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  const accountNumber = String(row?.bank_account_number ?? '').replace(/[\s-]/g, '');
  const branchCode = String(row?.bank_branch_code ?? '').replace(/[\s-]/g, '');
  const valid = validateBankAccount(accountNumber, branchCode);
  if (!valid.valid) {
    throw new PayrollBankFileRefusal('NO_PAYING_ACCOUNT',
      `The paying bank account ${holder.account.code} ${holder.account.name}: ${valid.error}. Set its account number and branch code on Bank Accounts.`);
  }
  return { branchCode, accountNumber };
}

export interface RunPayments {
  payments: AcbPayment[];
  /** Employee number per payment, in file order (for naming a writer refusal). */
  who: string[];
  employeeIds: string[];
  /** Every line's net in cents, nil included (the approved-total check). */
  linesCents: bigint;
  warnings: string[];
}

export async function readPayments(companyId: string, runId: string): Promise<RunPayments> {
  const rows = (await sql`
    SELECT l.employee_id, e.employee_number, e.first_name, e.last_name, round(l.net_pay * 100)::bigint::text AS net_cents,
           d.account_number, d.branch_code, d.account_type, d.account_holder,
           (COALESCE(d.activated_at, d.created_at) > COALESCE(h.approved_at, h.approval_grandfathered_at)) AS details_after_approval,
           COALESCE(NULLIF(c.trading_name, ''), c.name) AS company_name, h.period_year, h.period_month
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id AND h.company_id = ${companyId}::uuid
      JOIN companies c ON c.id = h.company_id
      JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
      LEFT JOIN payroll_bank_details d ON d.employee_id = e.id AND d.company_id = h.company_id AND d.is_active
     WHERE l.run_id = ${runId}::uuid
     ORDER BY e.employee_number, l.employee_id
  `) as DbRow[];
  const out: RunPayments = { payments: [], who: [], employeeIds: [], linesCents: 0n, warnings: [] };
  const problems: string[] = [];
  const changed: string[] = [];
  for (const r of rows) {
    const who = String(r.employee_number);
    const name = `${String(r.first_name)} ${String(r.last_name)}`;
    const cents = BigInt(String(r.net_cents));
    out.linesCents += cents;
    if (cents === 0n) { out.warnings.push(`${who} ${name}: not in the file: net pay is nil`); continue; }
    if (cents < 0n) { problems.push(`${who}: net pay is below zero`); continue; }
    if (r.account_number == null) { problems.push(`${who}: no active bank details`); continue; }
    if (r.details_after_approval === true) { changed.push(`${who} ${name}`); continue; }
    const valid = validateBankAccount(String(r.account_number), String(r.branch_code ?? ''));
    if (!valid.valid) problems.push(`${who}: ${valid.error}`);
    if (!ACB_TYPES.has(String(r.account_type))) problems.push(`${who}: account type '${String(r.account_type)}' cannot be paid by bank file`);
    out.who.push(who);
    out.employeeIds.push(String(r.employee_id));
    out.payments.push({
      branchCode: String(r.branch_code), accountNumber: String(r.account_number), accountType: r.account_type as AcbAccountType,
      amountCents: Number(cents), reference: salaryReference(String(r.company_name), Number(r.period_year), Number(r.period_month)),
      accountName: String(r.account_holder ?? '').trim() || name,
    });
  }
  if (changed.length > 0) {
    throw new PayrollBankFileRefusal('BANK_DETAILS_CHANGED',
      `Bank details changed after this run was approved, for ${changed.join(', ')}. Reopen and re-approve the run so the approver sees the new details.`,
      changed);
  }
  if (problems.length > 0) {
    throw new PayrollBankFileRefusal('EMPLOYEES_NOT_PAYABLE', `Employees on this run cannot be paid by bank file: ${problems.join('; ')}.`, problems);
  }
  if (out.payments.length === 0) throw new PayrollBankFileRefusal('EMPLOYEES_NOT_PAYABLE', 'This run has no employees to pay.');
  return out;
}

export async function judgeApprovedTotals(
  companyId: string, runId: string, period: { year: number; month: number }, linesCents: bigint,
): Promise<void> {
  const h = ((await sql`
    SELECT round(h.total_net * 100)::bigint::text AS approved_cents,
           (SELECT round(sum(jl.credit) * 100)::bigint::text
              FROM gl_journal_lines jl
              JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
             WHERE je.id = h.journal_entry_id AND je.company_id = h.company_id
               AND je.status = 'posted' AND je.reversed_at IS NULL AND je.source = 'auto_payroll'
               AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
               AND je.description = ${payrollRunJournalDescription(period.year, period.month)}
               AND jl.description IN (${NET_PAY_DESCRIPTION}, ${NET_PAY_CLEARING_DESCRIPTION})) AS journal_cents
      FROM payroll_run_headers h
     WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  const approved = h?.approved_cents == null ? null : BigInt(String(h.approved_cents));
  const journal = h?.journal_cents == null ? null : BigInt(String(h.journal_cents));
  if (journal === null) {
    throw new PayrollBankFileRefusal('JOURNAL_NOT_POSTED',
      'This run has no posted payroll journal of its own crediting its net pay (never posted, reversed, or not this run\'s). '
      + 'Post the payroll journal first, then pay it.');
  }
  if (approved !== linesCents || journal !== linesCents) {
    throw new PayrollBankFileRefusal('RUN_CHANGED_SINCE_APPROVAL',
      `This run's lines total ${rand(Number(linesCents))} net, but it was approved at ${approved === null ? 'no total' : rand(Number(approved))}`
      + ` and its journal credits ${rand(Number(journal))} net pay. Reopen and re-approve it before paying it.`);
  }
}
