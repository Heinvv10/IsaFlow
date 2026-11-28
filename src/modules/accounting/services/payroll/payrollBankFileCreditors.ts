/**
 * The garnishee creditors a salary bank file pays (wave 7 GC2, W12 part 2; Hein's ruling 5; migration 1057). Read-only.
 *
 * One credit record per garnishee order with a deduction on the run, after the employees' records: the amount the run
 * deducted from that employee for that order (payroll_garnishee_deductions, applied at approval), paid into the account
 * the order names (GC1, 1051). The record's account details and the order's creditor_bank_set_at are SNAPSHOTTED onto
 * its payroll_bank_file_items row (1057's guard refuses a snapshot that is not the order's current one): the order keeps
 * no history of its details, so the file's own row is the record of where the money went, and creditor_bank_set_at is
 * the version confirm compares (payrollBankFileCreditorJournal).
 *
 * Refused by name, before any write (CREDITORS_NOT_PAYABLE): an order with no creditor bank details, an account number
 * the ACB layout cannot carry (more than 11 digits: field 18 is never written), a deduction the approval did not apply.
 *
 * Who entered the details (GC1 design input #2, decided here): a manager may make the FIRST entry of an order's creditor
 * details while the run that deducts it is only calculated (1051 refuses a manager once an approval has applied a
 * deduction, or on an ended order). That entry is ACCEPTED, as a manager's first entry of an employee's bank details
 * before approval is (952, Hein's ruling on D1), and is NAMED: the file is generated only by an owner or admin
 * (payrollBankFileApi), and its warnings say, per order, that the details were entered by someone who is not an owner or
 * admin now, so the person uploading checks them against the court order first. No refusal: an owner or admin who
 * saves the same details again keeps the manager's stamp (1051), so a refusal could not be cleared without changing them.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatCents } from '@/lib/money/formatMoney';
import type { AcbAccountType, AcbPayment } from './payrollAcbFile';
import { PayrollBankFileRefusal } from './payrollBankFileStatus';

/** What a creditor line pays and the snapshot 1057 stores with it. */
export interface CreditorLine {
  orderId: string;
  employeeId: string;
  /** "<creditor> (employee <number>)", for refusals and warnings (never the court reference). */
  label: string;
  payment: AcbPayment;
  snapshot: {
    holder: string | null; bankName: string; branchCode: string; accountNumber: string; accountType: AcbAccountType; setAt: string;
  };
}

const ACB_TYPES: ReadonlySet<string> = new Set<AcbAccountType>(['cheque', 'savings', 'transmission']);

/** The run's creditor lines in file order (order kind, priority, creation, id), and the warnings they carry. */
export async function readCreditorPayments(companyId: string, runId: string): Promise<{ lines: CreditorLine[]; warnings: string[] }> {
  const rows = (await sql`
    SELECT d.order_id::text AS order_id, d.employee_id::text AS employee_id, round(d.amount * 100)::bigint::text AS cents,
           d.balance_applied, e.employee_number, o.reference, o.creditor_name,
           o.creditor_account_holder, o.creditor_bank_name, o.creditor_branch_code, o.creditor_account_number,
           o.creditor_account_type, o.creditor_bank_set_at::text AS set_at, o.creditor_bank_set_by,
           (SELECT cu.role FROM company_users cu WHERE cu.company_id = o.company_id AND cu.user_id::text = o.creditor_bank_set_by
             LIMIT 1) AS setter_role
      FROM payroll_garnishee_deductions d
      JOIN payroll_garnishee_orders o ON o.id = d.order_id AND o.company_id = d.company_id
      JOIN payroll_employees e ON e.id = d.employee_id AND e.company_id = d.company_id
     WHERE d.run_id = ${runId}::uuid AND d.company_id = ${companyId}::uuid AND d.amount > 0
     ORDER BY o.kind, o.priority, o.created_at, o.id
  `) as DbRow[];
  const lines: CreditorLine[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const r of rows) {
    const label = `${String(r.creditor_name)} (employee ${String(r.employee_number)})`;
    const cents = Number(r.cents);
    if (r.balance_applied !== true) { problems.push(`${label}: the run's approval has not applied this deduction`); continue; }
    if (r.creditor_account_number == null) { problems.push(`${label}: the garnishee order has no creditor bank details`); continue; }
    const account = String(r.creditor_account_number);
    if (account.length > 11) { problems.push(`${label}: the creditor account number has more than 11 digits, which a bank file cannot carry`); continue; }
    if (!ACB_TYPES.has(String(r.creditor_account_type))) { problems.push(`${label}: account type '${String(r.creditor_account_type)}' cannot be paid by bank file`); continue; }
    const role = r.setter_role == null ? null : String(r.setter_role);
    if (role !== 'owner' && role !== 'admin') {
      warnings.push(`${label}: the creditor bank details (account ending ${account.slice(-4)}, ${formatCents(cents)}) were entered by `
        + `${role ? `a ${role}` : 'someone no longer in this company'}, not an owner or admin. Check them against the court order before uploading the file.`);
    }
    const holder = r.creditor_account_holder == null ? null : String(r.creditor_account_holder);
    const snapshot = {
      holder, bankName: String(r.creditor_bank_name), branchCode: String(r.creditor_branch_code), accountNumber: account,
      accountType: r.creditor_account_type as AcbAccountType, setAt: String(r.set_at),
    };
    lines.push({
      orderId: String(r.order_id), employeeId: String(r.employee_id), label, snapshot,
      payment: {
        branchCode: snapshot.branchCode, accountNumber: account, accountType: snapshot.accountType, amountCents: cents,
        // The creditor's statement shows the order's reference (the court / case number they file it under).
        reference: String(r.reference), accountName: (holder ?? '').trim() || String(r.creditor_name),
      },
    });
  }
  if (problems.length > 0) {
    throw new PayrollBankFileRefusal('CREDITORS_NOT_PAYABLE',
      `Garnishee creditors on this run cannot be paid by bank file: ${problems.join('; ')}. Enter the creditor's bank details on the order, then generate again.`,
      problems);
  }
  return { lines, warnings };
}

/** The items rows (unnest arrays) of the creditor lines, in file order. */
export function creditorItemArrays(lines: readonly CreditorLine[]) {
  return {
    orderIds: lines.map((l) => l.orderId), employeeIds: lines.map((l) => l.employeeId),
    cents: lines.map((l) => String(l.payment.amountCents)), holders: lines.map((l) => l.snapshot.holder),
    bankNames: lines.map((l) => l.snapshot.bankName), branches: lines.map((l) => l.snapshot.branchCode),
    accounts: lines.map((l) => l.snapshot.accountNumber), types: lines.map((l) => l.snapshot.accountType),
    setAts: lines.map((l) => l.snapshot.setAt),
  };
}
