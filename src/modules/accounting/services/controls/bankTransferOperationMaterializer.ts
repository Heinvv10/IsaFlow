import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';
import { assertControlTx } from './context';
import { canonicalJson, canonicalMoney } from './canonical';
import { readControlEntityVersion } from './operationVersions';
import type { ControlTx, OperationRef } from './contracts';
import type { ApMaterial, ObservedSource } from './apOperationMaterializer';
type Row = Record<string, unknown>;

/** The immutable intent contains business input; currency and account eligibility come from owned rows. */
export async function materializeBankTransferOperation(ctx: ControlTx, ref: OperationRef): Promise<ApMaterial> {
  assertControlTx(ctx);
  if (ref.entityType !== 'bank_transfer_intent' || !UUID_RE.test(ref.entityId)
    || !['bank_transfer.post'].includes(ref.operation)) throw new Error('Unsupported bank transfer operation');
  const companyId = ctx.principal.companyId;
  const [company] = await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text
    FROM companies WHERE id=${companyId}::uuid FOR SHARE` as Row[];
  const [intent] = await ctx.sql`SELECT id,requester_person_id,from_gl_account_id,to_gl_account_id,
    amount::text,accounting_date::text,reference FROM control_bank_transfer_intents
    WHERE company_id=${companyId}::uuid AND id=${ref.entityId}::uuid` as Row[];
  if (!company || !intent) throw new Error('Bank transfer operation not found');
  const currency = company.default_currency, date = intent.accounting_date;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    const state = currency == null || currency === '' ? 'no default currency set' : `an invalid default currency (${String(currency)})`;
    throw new BankTransferRefusalError(`Cannot transfer: this company has ${state}. Set it before transferring between bank accounts.`);
  }
  // The intent's date was validated when it was prepared: an unreadable one is a fault, not a refusal.
  if (typeof date !== 'string' || !isRealCalendarDate(date)) throw new Error('Bank transfer date unavailable');
  if (typeof intent.amount !== 'string') throw new Error('Bank transfer decimal amount unavailable');
  const amount = canonicalMoney(intent.amount);
  if (!new Decimal(amount).gt(0) || intent.from_gl_account_id === intent.to_gl_account_id) throw new Error('Invalid transfer amount or accounts');
  const ids = [String(intent.from_gl_account_id), String(intent.to_gl_account_id)].sort();
  const accounts = await readTransferAccounts(ctx, companyId, String(intent.from_gl_account_id), String(intent.to_gl_account_id));
  // Per account, two rows each (enough to see a duplicate): one query with a shared LIMIT let an account with three
  // records crowd the other out, and the refusal then said the other had none. Re-sorted by id, the order the single
  // query returned, so the material — and every approval's binding hash — is unchanged for well-formed accounts.
  const banks: Row[] = [];
  for (const glAccountId of ids) {
    banks.push(...await ctx.sql`SELECT id,gl_account_id,currency,is_active FROM bank_accounts
      WHERE company_id=${companyId}::uuid AND gl_account_id=${glAccountId}::uuid ORDER BY id LIMIT 2 FOR SHARE` as Row[]);
  }
  banks.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  if (banks.length !== 2 || new Set(banks.map(b => b.gl_account_id)).size !== 2
    || banks.some(b => !ids.includes(String(b.gl_account_id)) || b.currency !== currency)) {
    throw new BankTransferRefusalError(currencyRefusal(accounts, banks, currency));
  }
  const periods = await ctx.sql`SELECT id,start_date::text,end_date::text,status FROM fiscal_periods
    WHERE company_id=${companyId}::uuid AND start_date<=${date}::date AND end_date>=${date}::date ORDER BY id FOR SHARE` as Row[];
  if (periods.length === 0) {
    throw new BankTransferRefusalError(`Cannot transfer: no fiscal period covers ${date}. Set up the fiscal year that contains this date first.`);
  }
  // Overlapping periods are corrupt data the product never creates: a fault, not the person's to fix.
  if (periods.length !== 1) throw new Error('Transfer fiscal period missing or ambiguous');
  const plan = [{ glAccountId: String(intent.to_gl_account_id), debit: amount, credit: '0' },
    { glAccountId: String(intent.from_gl_account_id), debit: '0', credit: amount }];
  const facts = { company, intent, accounts, banks, period: periods[0]!, plan };
  const prior = await readControlEntityVersion(ctx, ref);
  const observed: ObservedSource = { entityType: ref.entityType, entityId: ref.entityId, version: prior?.version ?? 1,
    tracked: prior !== null, facts, fingerprint: createHash('sha256').update(canonicalJson(facts)).digest('hex') };
  if (ref.expectedVersion !== undefined && ref.expectedVersion !== observed.version) throw new Error('Transfer version changed');
  return { supplierId: '', observedSources: [observed], versionBasis: prior ? 'recorded_with_current_fingerprint' : 'untracked_current_observation',
    binding: { companyId, operation: ref.operation, entityType: ref.entityType, entityId: ref.entityId, entityVersion: observed.version,
      accountingDate: date, amount, currency, beneficiaries: [], sourceVersions: [{ entityType: ref.entityType,
        entityId: ref.entityId, version: observed.version, fingerprint: observed.fingerprint }] } };
}

/**
 * A transfer refused for a reason the person can fix, stated so they can: 400 for their own input,
 * 404 for an intent that is not theirs, 422 for what the company's rows do not allow. Never a 500, and always thrown inside the
 * operation's savepoint (or before any write), so nothing it touched is committed.
 */
export class BankTransferRefusalError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 422 = 422) {
    super(message);
    this.name = 'BankTransferRefusalError';
  }
}

/** Names each account whose bank record stops the transfer: missing, duplicated, no currency, or another currency. */
function currencyRefusal(accounts: Row[], banks: Row[], currency: string): string {
  const problems = accounts.map(account => {
    const label = `${String(account.account_code)} ${String(account.account_name)}`;
    const own = banks.filter(bank => String(bank.gl_account_id) === String(account.id));
    if (own.length === 0) return `${label} has no bank account record`;
    if (own.length > 1) return `${label} has more than one bank account record`;
    const bankCurrency = own[0]!.currency;
    if (bankCurrency == null || bankCurrency === '') return `${label} has no currency set`;
    return bankCurrency === currency ? null : `${label} is in ${String(bankCurrency)}`;
  }).filter((problem): problem is string => problem !== null);
  return `Cannot transfer between these bank accounts: ${problems.join('; ') || 'their bank account records do not match'}. `
    + `Both must have the ledger currency (${currency}).`;
}

/** Posting refuses an account (or its bank record) that has been deactivated since preparation. */
export function assertTransferAccountsActive(accounts: Row[], banks: Row[]): void {
  const problems = accounts.flatMap(account => {
    const label = `${String(account.account_code)} ${String(account.account_name)}`;
    const own = banks.filter(bank => String(bank.gl_account_id) === String(account.id));
    return [
      ...(account.is_active !== true ? [`${label} is inactive`] : []),
      ...(own.some(bank => bank.is_active !== true) ? [`${label} has an inactive bank account record`] : []),
    ];
  });
  if (problems.length > 0) throw new BankTransferRefusalError(`Cannot post this transfer: ${problems.join('; ')}.`);
}

/** Names each intent account the company-scoped read did not return as a bank account; a foreign one reads as not found. */
function accountsRefusal(accounts: Row[], intentIds: string[]): string {
  const problems = intentIds.map(id => {
    const account = accounts.find(a => String(a.id) === id);
    if (!account) return `account ${id} was not found in this company`;
    return account.account_subtype === 'bank' ? null : `${String(account.account_code)} ${String(account.account_name)} is not a bank account`;
  }).filter((problem): problem is string => problem !== null);
  return `Cannot transfer between these accounts: ${problems.join('; ') || 'they are not this company\'s bank accounts'}.`;
}

/**
 * The two accounts, read company-scoped and refused unless both are this company's bank accounts. Preparation calls
 * it BEFORE writing the intent: the intent's composite foreign key would otherwise answer an absent or foreign
 * account with a 23503 and a 500. Absent and foreign read the same.
 */
export async function readTransferAccounts(ctx: ControlTx, companyId: string, fromId: string, toId: string): Promise<Row[]> {
  const ids = [fromId, toId].sort();
  const accounts = await ctx.sql`SELECT id,account_code,account_name,account_subtype,is_active
    FROM gl_accounts WHERE company_id=${companyId}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE` as Row[];
  if (accounts.length !== 2 || accounts.some(a => !ids.includes(String(a.id)) || a.account_subtype !== 'bank')) {
    throw new BankTransferRefusalError(accountsRefusal(accounts, [fromId, toId]));
  }
  return accounts;
}

/**
 * Posting refuses a period that is not open, or the company lockdown, HERE — before the journal is written. Inside
 * the journal control the same refusal marks the request failed and it answers 500 (withControlRequest). Mirrors
 * journalEntryPostingService.assertPostingGuards; if the two ever drift, that guard still refuses, as a fault.
 */
export function assertTransferPostable(company: Row, period: Row, date: string): void {
  if (period.status !== 'open') {
    throw new BankTransferRefusalError(`Cannot post this transfer dated ${date}: its fiscal period (${String(period.start_date)} to ${String(period.end_date)}) is ${String(period.status)}.`);
  }
  if (company.lockdown_enabled === true && (!company.lockdown_date || date <= String(company.lockdown_date))) {
    const until = company.lockdown_date ? ` up to ${String(company.lockdown_date)}` : '';
    throw new BankTransferRefusalError(`Cannot post this transfer dated ${date}: the company is locked down${until}.`);
  }
}
