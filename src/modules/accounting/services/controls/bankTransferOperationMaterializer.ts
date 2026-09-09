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
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || typeof date !== 'string' || !isRealCalendarDate(date)) {
    throw new Error('Bank transfer currency or date unavailable');
  }
  if (typeof intent.amount !== 'string') throw new Error('Bank transfer decimal amount unavailable');
  const amount = canonicalMoney(intent.amount);
  if (!new Decimal(amount).gt(0) || intent.from_gl_account_id === intent.to_gl_account_id) throw new Error('Invalid transfer amount or accounts');
  const ids = [String(intent.from_gl_account_id), String(intent.to_gl_account_id)].sort();
  const accounts = await ctx.sql`SELECT id,account_code,account_name,account_subtype,is_active
    FROM gl_accounts WHERE company_id=${companyId}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE` as Row[];
  if (accounts.length !== 2 || accounts.some(a => !ids.includes(String(a.id)) || a.account_subtype !== 'bank')) {
    throw new Error('Bank transfer accounts are not owned bank accounts');
  }
  const banks = await ctx.sql`SELECT id,gl_account_id,currency,is_active FROM bank_accounts
    WHERE company_id=${companyId}::uuid AND gl_account_id=ANY(${ids}::uuid[]) ORDER BY id LIMIT 3 FOR SHARE` as Row[];
  if (banks.length !== 2 || new Set(banks.map(b => b.gl_account_id)).size !== 2
    || banks.some(b => !ids.includes(String(b.gl_account_id)) || b.currency !== currency)) {
    throw new Error('Bank account currency is unknown or differs from ledger currency');
  }
  const periods = await ctx.sql`SELECT id,start_date::text,end_date::text,status FROM fiscal_periods
    WHERE company_id=${companyId}::uuid AND start_date<=${date}::date AND end_date>=${date}::date ORDER BY id FOR SHARE` as Row[];
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
