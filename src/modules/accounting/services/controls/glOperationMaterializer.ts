import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { journalAffectsVatReturn } from './journalVatFootprint';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';
import { canonicalJson, canonicalMoney } from './canonical';
import { assertControlTx } from './context';
import { readControlEntityVersion } from './operationVersions';
import type { ControlTx, OperationRef } from './contracts';
import type { ApMaterial, ObservedSource } from './apOperationMaterializer';

type Row = Record<string, unknown>;
// Bounded canonical money supports larger values than decimal.js's default precision.
const Money = Decimal.clone({ precision: 80 });
export function deriveJournalAmount(lines: readonly { debit: string; credit: string }[]): string {
  if (lines.length < 2 || lines.length > 10000) throw new Error('Journal line population is invalid');
  let debit = new Money(0), credit = new Money(0);
  for (const line of lines) {
    const d = new Money(canonicalMoney(line.debit)), c = new Money(canonicalMoney(line.credit));
    if (d.isNegative() || c.isNegative() || (d.gt(0) && c.gt(0)) || (!d.gt(0) && !c.gt(0))) throw new Error('Invalid journal debit/credit');
    debit = debit.add(d); credit = credit.add(c);
  }
  if (!debit.gt(0) || !debit.eq(credit)) throw new Error('Journal is not exactly balanced');
  return canonicalMoney(debit.toFixed());
}
async function observe(ctx: ControlTx, entityType: string, entityId: string, facts: Row): Promise<ObservedSource> {
  const previous = await readControlEntityVersion(ctx, { entityType, entityId });
  return { entityType, entityId, version: previous?.version ?? 1, tracked: previous !== null, facts,
    fingerprint: createHash('sha256').update(canonicalJson(facts)).digest('hex') };
}
/** Material only: status eligibility belongs to the writer so after-effect evidence can be captured. */
export async function materializeGlOperation(ctx: ControlTx, ref: OperationRef): Promise<ApMaterial> {
  assertControlTx(ctx);
  if (ref.entityType !== 'journal_entry' || !UUID_RE.test(ref.entityId) || !['journal.post', 'journal.reverse'].includes(ref.operation)) {
    throw new Error('Unsupported journal operation');
  }
  const companyId = ctx.principal.companyId;
  const [company] = await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text
    FROM companies WHERE id=${companyId}::uuid FOR SHARE` as Row[];
  if (!company || typeof company.default_currency !== 'string' || !/^[A-Z]{3}$/.test(company.default_currency)) throw new Error('Ledger currency unavailable');
  const [header] = await ctx.sql`SELECT id,entry_number,entry_date::text,fiscal_period_id,description,source,reference,
    source_document_id,source_record_id,status,reversed_at,reversal_of_id
    FROM gl_journal_entries WHERE company_id=${companyId}::uuid AND id=${ref.entityId}::uuid FOR UPDATE` as Row[];
  if (!header || !isRealCalendarDate(String(header.entry_date))) throw new Error('Journal not found or dated incorrectly');
  // Parent lock prevents inserted line phantoms through the journal FK; account locks prevent concurrent deactivation.
  const storedLines = await ctx.sql`SELECT id,gl_account_id,debit::text,credit::text,description,project_id,cost_center_id,cc1_id,cc2_id,bu_id,vat_type
    FROM gl_journal_lines WHERE company_id=${companyId}::uuid AND journal_entry_id=${ref.entityId}::uuid
    ORDER BY id LIMIT 10001 FOR SHARE` as Array<Row & { debit: string; credit: string }>;
  // Previously absent null keys preserve legacy material; actual dimensions must now participate.
  const lines:Array<Row & {debit:string;credit:string}>=storedLines.map(({cc1_id,cc2_id,...line})=>({...line,...(cc1_id==null?{}:{cc1_id}),...(cc2_id==null?{}:{cc2_id})}));
  const amount = deriveJournalAmount(lines);
  const accountIds = [...new Set(lines.map(line => String(line.gl_account_id)))].sort();
  const accounts = await ctx.sql`SELECT id,account_code,account_name,account_type,account_subtype,is_active
    FROM gl_accounts WHERE company_id=${companyId}::uuid AND id=ANY(${accountIds}::uuid[]) ORDER BY id FOR SHARE` as Row[];
  if (accounts.length !== accountIds.length) throw new Error('Journal account ownership is invalid');
  const originalDate = String(header.entry_date);
  const periods = await ctx.sql`SELECT id,fiscal_year,start_date::text,end_date::text,status
    FROM fiscal_periods WHERE company_id=${companyId}::uuid AND start_date<=${originalDate}::date AND end_date>=${originalDate}::date
    ORDER BY id FOR SHARE` as Row[];
  if (periods.length !== 1 || String(periods[0]!.id) !== String(header.fiscal_period_id)) throw new Error('Journal fiscal period is missing or ambiguous');
  let accountingDate = originalDate;
  const requested = (ref as OperationRef & { reversalDate?: string }).reversalDate;
  if (requested !== undefined && (ref.operation !== 'journal.reverse' || !isRealCalendarDate(requested) || requested < originalDate)) {
    throw new Error('Invalid reversal date');
  }
  if (ref.operation === 'journal.reverse') {
    const [clock] = await ctx.sql`SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day` as { day: string }[];
    if (!clock || !isRealCalendarDate(clock.day)) throw new Error('Journal execution date unavailable');
    accountingDate = requested ?? (periods[0]!.status === 'open' ? originalDate : clock.day);
  }
  const targets = accountingDate === originalDate ? periods : await ctx.sql`SELECT id,fiscal_year,start_date::text,end_date::text,status
    FROM fiscal_periods WHERE company_id=${companyId}::uuid AND start_date<=${accountingDate}::date AND end_date>=${accountingDate}::date
    ORDER BY id FOR SHARE` as Row[];
  if (targets.length !== 1) throw new Error('Target fiscal period is missing or ambiguous');
  const vatLocks = journalAffectsVatReturn(lines, accounts) ? await ctx.sql`
    SELECT id,period_start::text,period_end::text,locked_at FROM vat_period_locks
    WHERE company_id=${companyId}::uuid AND period_start<=${accountingDate}::date
      AND period_end>=${accountingDate}::date ORDER BY id FOR SHARE
  ` as Row[] : [];
  const facts = { header, lines, accounts, company, vatLocks, originalPeriod: periods[0]!, targetPeriod: targets[0]!, accountingDate };
  const parent = await observe(ctx, ref.entityType, ref.entityId, facts);
  if (ref.expectedVersion !== undefined && ref.expectedVersion !== parent.version) throw new Error('Journal version changed');
  const sources = [parent, await observe(ctx, 'company_gl_settings', companyId, company)];
  for (const account of accounts) sources.push(await observe(ctx, 'gl_account', String(account.id), account));
  const uniquePeriods = new Map([...periods, ...targets].map(period => [String(period.id), period]));
  for (const [id, period] of uniquePeriods) sources.push(await observe(ctx, 'fiscal_period', id, period));
  return { supplierId: '', observedSources: sources,
    versionBasis: sources.every(source => source.tracked) ? 'recorded_with_current_fingerprint' : 'untracked_current_observation',
    binding: { companyId, operation: ref.operation, entityType: ref.entityType, entityId: ref.entityId,
      entityVersion: parent.version, accountingDate, amount, currency: company.default_currency,
      beneficiaries: [], sourceVersions: sources.map(({ facts: _facts, tracked: _tracked, ...source }) => source) } };
}
