/**
 * The creditor's bank details on a garnishee order (wave 7 GC1, W12 part 1; migration 1051): the account the creditor
 * is paid into. GC2 pays it from the salary bank file; nothing here touches the bank file or the ledger.
 *
 * Validated as an employee's bank details are (parseBankDetailsInput: bank, 6-digit branch code, 6 to 16 digit
 * account number, cheque / savings / transmission, optional holder).
 * Who: the routes admit payroll-detail roles (owner, admin, manager) in their own session, never Login-as or a token
 * (payrollGarnisheeApi.garnisheeWriter). A change to details already entered is owner / admin only
 * (CHANGE_REQUIRES_ADMIN), as an employee's (Hein's decision 14). The first entry is any of them, except that a
 * manager's is refused (FIRST_ENTRY_REQUIRES_ADMIN, as an employee's under Hein's ruling on D1) on an order that is
 * ended or carries creditor_entry_admin_only (1051: set when an approval applies one of its deductions, never cleared,
 * so a reopen or recalculation does not forget it): money already owed to the creditor would otherwise follow an
 * account a manager chose. 1051's trigger holds both rules, on the same two columns, for any other writer.
 * The same details sent again write nothing (decided after the role, so a manager cannot test a guessed number).
 * Lock order (a manager): the company payroll-approval lock, then the order row, as approval and reopen take them, so
 * an approval in flight commits its flag before the verdict; an owner / admin is never refused by it and takes only the row.
 * Masking: everyone sees the account number to its last four, the branch code to its last two and the holder to its
 * first letter (entityChangeMasking), except an owner / admin's full read (GET without view=masked), which is recorded
 * in audit_log (`export`) in the read's transaction; the record names the fields, never the values. A change's audit
 * row carries masked values and, in metadata, the names of the fields whose full values changed (two numbers with the
 * same last four would otherwise look unchanged). No log line carries a value. A table CHECK refusal (23514, whose
 * DETAIL would carry the row) is rethrown without the driver's text.
 * Every refusal is raised before the first write (a 4xx commits the request).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { maskInitial, maskLastTwo, maskValue } from '@/modules/accounting/services/core/entityChanges/entityChangeMasking';
import { isHistoryAdmin } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { ROW_LOCK_BUDGET_MS, RowLockTimeoutError, withRowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';
import type { AccountType, BankDetailsInput } from './payrollBankDetailsService';
import type { GarnisheeActor } from './payrollGarnisheeOrders';
import { payrollApprovalLockScope } from './payrollRunLock';

export interface CreditorBank {
  bankName: string;
  /** In full only on an owner / admin's full read, else `…1234`. */
  accountNumber: string;
  /** In full only on an owner / admin's full read, else `…55`. */
  branchCode: string;
  accountType: AccountType;
  /** In full only on an owner / admin's full read, else its first letter and `…`. */
  accountHolder: string | null;
  masked: boolean;
  setAt: string | null;
}

export type CreditorBankRefusalCode = 'ORDER_NOT_FOUND' | 'CHANGE_REQUIRES_ADMIN' | 'FIRST_ENTRY_REQUIRES_ADMIN';

/** A refusal, raised before anything is written. */
export class CreditorBankRefusal extends Error {
  readonly status: 403 | 404;
  constructor(readonly code: CreditorBankRefusalCode, message: string) {
    super(message);
    this.name = 'CreditorBankRefusal';
    this.status = code === 'ORDER_NOT_FOUND' ? 404 : 403;
  }
}

const REVEALED = 'creditor_account_number,creditor_branch_code,creditor_account_holder';
const at = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** The order row's creditor account, in full or masked; null when none is entered. Pure. */
export function creditorBankView(r: DbRow, full: boolean): CreditorBank | null {
  if (r.creditor_account_number == null) return null;
  const holder = r.creditor_account_holder == null ? null : String(r.creditor_account_holder);
  return {
    bankName: String(r.creditor_bank_name),
    accountNumber: full ? String(r.creditor_account_number) : String(maskValue(String(r.creditor_account_number))),
    branchCode: full ? String(r.creditor_branch_code) : String(maskLastTwo(String(r.creditor_branch_code))),
    accountType: r.creditor_account_type as AccountType,
    accountHolder: full ? holder : (maskInitial(holder) as string | null),
    masked: !full,
    setAt: at(r.creditor_bank_set_at),
  };
}

/** The order row, locked for a write, with the two facts the first-entry rule reads (status, creditor_entry_admin_only). */
async function orderRowForWrite(companyId: string, employeeId: string, orderId: string): Promise<DbRow> {
  const rows = (await sql`
    SELECT id, status, creditor_entry_admin_only, creditor_account_holder, creditor_bank_name, creditor_branch_code,
           creditor_account_number, creditor_account_type, creditor_bank_set_at
      FROM payroll_garnishee_orders
     WHERE id = ${orderId}::uuid AND company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
     FOR NO KEY UPDATE
  `) as DbRow[];
  if (!rows[0]) throw new CreditorBankRefusal('ORDER_NOT_FOUND', 'Garnishee order not found.');
  return rows[0];
}

async function orderRow(companyId: string, employeeId: string, orderId: string): Promise<DbRow> {
  const rows = (await sql`
    SELECT id, creditor_account_holder, creditor_bank_name, creditor_branch_code, creditor_account_number,
           creditor_account_type, creditor_bank_set_at
      FROM payroll_garnishee_orders
     WHERE id = ${orderId}::uuid AND company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
  `) as DbRow[];
  if (!rows[0]) throw new CreditorBankRefusal('ORDER_NOT_FOUND', 'Garnishee order not found.');
  return rows[0];
}

/**
 * The order's creditor account: in full for owner / admin unless `masked` (and that full read is audited), else
 * masked. Refused 404 for another company's or employee's order.
 */
export async function getCreditorBank(
  companyId: string, employeeId: string, orderId: string, role: string | undefined, masked: boolean, actor: GarnisheeActor,
): Promise<CreditorBank | null> {
  const full = !masked && isHistoryAdmin(role);
  const view = creditorBankView(await orderRow(companyId, employeeId, orderId), full);
  if (view && full) {
    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'export', entityType: 'payroll_garnishee_order',
      entityId: orderId, changes: { fields: [], metadata: { revealed: REVEALED, employeeId } },
      ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
    });
  }
  return view;
}

/** The stored fields whose full values differ (all five for a first entry): names only, for the audit row. */
function changedFields(r: DbRow | null, i: BankDetailsInput): string[] {
  const pairs: Array<[string, unknown, unknown]> = [
    ['creditor_bank_name', r?.creditor_bank_name, i.bankName], ['creditor_branch_code', r?.creditor_branch_code, i.branchCode],
    ['creditor_account_number', r?.creditor_account_number, i.accountNumber], ['creditor_account_type', r?.creditor_account_type, i.accountType],
    ['creditor_account_holder', r?.creditor_account_holder ?? null, i.accountHolder],
  ];
  return pairs.filter(([, before, after]) => r === null || before !== after).map(([name]) => name);
}

const same = (r: DbRow, i: BankDetailsInput) => r.creditor_bank_name === i.bankName && r.creditor_branch_code === i.branchCode
  && r.creditor_account_number === i.accountNumber && r.creditor_account_type === i.accountType
  && (r.creditor_account_holder ?? null) === i.accountHolder;

/**
 * Enter or change the creditor's account on the order, from parseBankDetailsInput's output; returns the masked view.
 * Locks: a manager first takes the company payroll-approval lock; then the order row (FOR NO KEY UPDATE). Both waits
 * share one ~5 s budget, then 503 retry.
 */
export async function setCreditorBank(
  companyId: string, employeeId: string, orderId: string, input: BankDetailsInput, role: string | undefined, actor: GarnisheeActor,
): Promise<CreditorBank> {
  const admin = isHistoryAdmin(role);
  const deadline = Date.now() + ROW_LOCK_BUDGET_MS;
  if (!admin) {
    await withRowLockBudget(() => sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${payrollApprovalLockScope(companyId)}, 0))
    `, () => new RowLockTimeoutError('Payroll for this company'), { deadline });
  }
  const row = await withRowLockBudget(() => orderRowForWrite(companyId, employeeId, orderId),
    () => new RowLockTimeoutError('This garnishee order'), { deadline });
  const existing = row.creditor_account_number != null;
  if (existing && !admin) {
    throw new CreditorBankRefusal('CHANGE_REQUIRES_ADMIN', 'Only an owner or admin can change a creditor\'s bank details once entered.');
  }
  if (!existing && !admin && (row.status === 'ended' || row.creditor_entry_admin_only === true)) {
    throw new CreditorBankRefusal('FIRST_ENTRY_REQUIRES_ADMIN',
      'Only an owner or admin can enter the creditor\'s bank details on an order that has ended or that an approved pay run has deducted.');
  }
  if (existing && same(row, input)) return creditorBankView(row, false)!;

  const updated = (await sql`
    UPDATE payroll_garnishee_orders
       SET creditor_account_holder = ${input.accountHolder}, creditor_bank_name = ${input.bankName},
           creditor_branch_code = ${input.branchCode}, creditor_account_number = ${input.accountNumber},
           creditor_account_type = ${input.accountType}
     WHERE id = ${orderId}::uuid AND company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
    RETURNING id, creditor_account_holder, creditor_bank_name, creditor_branch_code, creditor_account_number,
              creditor_account_type, creditor_bank_set_at
  `.catch((err: unknown) => {
    // A CHECK refusal's DETAIL carries the failing row (the full number): never let it reach a log or a response.
    if ((err as { code?: string }).code === '23514') throw new Error('The creditor bank details were refused by the table check.');
    throw err;
  })) as DbRow[];
  const after = updated[0];
  if (!after) throw new CreditorBankRefusal('ORDER_NOT_FOUND', 'Garnishee order not found.');
  const before = existing ? creditorBankView(row, false) : null;
  const now = creditorBankView(after, false)!;
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_garnishee_order',
    entityId: orderId, changes: { fields: [
      { field: 'creditor_bank_name', old: before?.bankName ?? null, new: now.bankName, label: 'Creditor bank' },
      { field: 'creditor_branch_code', old: before?.branchCode ?? null, new: now.branchCode, label: 'Creditor branch code' },
      { field: 'creditor_account_number', old: before?.accountNumber ?? null, new: now.accountNumber, label: 'Creditor account number' },
      { field: 'creditor_account_type', old: before?.accountType ?? null, new: now.accountType, label: 'Creditor account type' },
      { field: 'creditor_account_holder', old: before?.accountHolder ?? null, new: now.accountHolder, label: 'Creditor account holder' },
    ], metadata: { changedFields: changedFields(existing ? row : null, input).join(',') } },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  log.info('setCreditorBank', { companyId, employeeId, orderId, changed: existing });
  return now;
}
