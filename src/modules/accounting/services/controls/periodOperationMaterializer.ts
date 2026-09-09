import { createHash } from 'node:crypto';
import { isRealCalendarDate, UUID_RE } from '@/lib/validation';
import { canonicalJson } from './canonical';
import { assertControlTx } from './context';
import { readControlEntityVersion } from './operationVersions';
import { getVat201Report } from '../reports/vat201ReportService';
import type { ControlTx, EntityRef, OperationRef } from './contracts';
import type { ApMaterial, ObservedSource } from './apOperationMaterializer';
type Row = Record<string, unknown>;
export function parseVatPeriodId(id: string): { start: string; end: string } {
  const [start, end, extra] = id.split('/');
  if (!start || !end || extra !== undefined || !isRealCalendarDate(start) || !isRealCalendarDate(end) || start > end) throw new Error('Invalid VAT period reference');
  return { start, end };
}
async function observe(ctx: ControlTx, ref: EntityRef, facts: Row): Promise<ObservedSource> {
  const prior = await readControlEntityVersion(ctx, ref);
  return { ...ref, version: prior?.version ?? 1, tracked: prior !== null, facts,
    fingerprint: createHash('sha256').update(canonicalJson(facts)).digest('hex') };
}
export async function materializePeriodOperation(ctx: ControlTx, ref: OperationRef): Promise<ApMaterial> {
  assertControlTx(ctx);
  const companyId = ctx.principal.companyId;
  // Company/VAT lock insertion serializes with GL's locked company read, even when no lock row exists yet.
  const exclusive = ['company_lockdown_intent', 'vat_period'].includes(ref.entityType);
  const companies = exclusive
    ? await ctx.sql`SELECT id,lockdown_enabled,lockdown_date::text,default_currency FROM companies WHERE id=${companyId}::uuid FOR UPDATE`
    : await ctx.sql`SELECT id,lockdown_enabled,lockdown_date::text,default_currency FROM companies WHERE id=${companyId}::uuid FOR SHARE`;
  const company = companies[0] as Row | undefined;
  if (!company) throw new Error('Operation not found');
  let periods: Row[] = [], start: string | null = null, end: string | null = null, intent: Row | null = null;
  if (ref.entityType === 'fiscal_period') {
    if (!UUID_RE.test(ref.entityId)) throw new Error('Invalid fiscal period reference');
    const [selected] = await ctx.sql`SELECT fiscal_year FROM fiscal_periods WHERE company_id=${companyId}::uuid AND id=${ref.entityId}::uuid` as Row[];
    if (!selected) throw new Error('Operation not found');
    periods = await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${companyId}::uuid AND fiscal_year=${selected.fiscal_year}
      ORDER BY id FOR UPDATE` as Row[];
    const target = periods.find(row => row.id === ref.entityId);
    if (!target) throw new Error('Operation not found');
    start = date(target.start_date); end = date(target.end_date);
  } else if (ref.entityType === 'fiscal_year') {
    if (!/^[1-9][0-9]{3}$/.test(ref.entityId)) throw new Error('Invalid fiscal year reference');
    periods = await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${companyId}::uuid AND fiscal_year=${Number(ref.entityId)}
      ORDER BY id FOR UPDATE` as Row[];
    if (!periods.length) throw new Error('Operation not found');
    start = periods.map(row => date(row.start_date)).sort()[0]!;
    end = periods.map(row => date(row.end_date)).sort().at(-1)!;
  } else if (ref.entityType === 'vat_period') {
    ({ start, end } = parseVatPeriodId(ref.entityId));
    periods = await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${companyId}::uuid
      AND start_date<=${end}::date AND end_date>=${start}::date ORDER BY id FOR UPDATE` as Row[];
  } else if (ref.entityType === 'company_lockdown_intent') {
    if (!UUID_RE.test(ref.entityId)) throw new Error('Invalid lockdown intent reference');
    [intent = null] = await ctx.sql`SELECT * FROM control_lockdown_intents WHERE company_id=${companyId}::uuid AND id=${ref.entityId}::uuid FOR SHARE` as Row[];
    if (!intent) throw new Error('Operation not found');
    const [clock] = await ctx.sql`SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day` as { day: string }[];
    if (!clock || !isRealCalendarDate(clock.day)) throw new Error('Lockdown operation date unavailable');
    end = clock.day;
  } else throw new Error('Unsupported period operation');
  const journals = start && end ? await ctx.sql`SELECT * FROM gl_journal_entries WHERE company_id=${companyId}::uuid
    AND entry_date>=${start}::date AND entry_date<=${end}::date ORDER BY id LIMIT 10001 FOR SHARE` as Row[] : [];
  if (journals.length > 10000) throw new Error('Period exceeds the 10000-journal synchronous control limit');
  const ids = journals.map(row => String(row.id));
  const lines = ids.length ? await ctx.sql`SELECT * FROM gl_journal_lines WHERE company_id=${companyId}::uuid
    AND journal_entry_id=ANY(${ids}::uuid[]) ORDER BY id LIMIT 50001 FOR SHARE` as Row[] : [];
  if (lines.length > 50000) throw new Error('Period exceeds the 50000-line synchronous control limit');
  const accountIds = [...new Set(lines.map(row => String(row.gl_account_id)))].sort();
  const accounts = accountIds.length ? await ctx.sql`SELECT id,account_code,account_name,account_type,account_subtype,is_active
    FROM gl_accounts WHERE company_id=${companyId}::uuid AND id=ANY(${accountIds}::uuid[]) ORDER BY id FOR SHARE` as Row[] : [];
  if (accounts.length !== accountIds.length) throw new Error('Period journal account ownership is invalid');
  let vat: Row | null = null;
  if (ref.entityType === 'vat_period') {
    const report = await getVat201Report(companyId, start!, end!, { detail: 'summary' });
    const locks = await ctx.sql`SELECT * FROM vat_period_locks WHERE company_id=${companyId}::uuid
      AND period_start=${start}::date AND period_end=${end}::date FOR UPDATE` as Row[];
    vat = { figures: { outputTax: report.totals.outputTax, inputTax: report.totals.inputTax,
      netVat: report.totals.netVat, postedThrough: report.postedThrough }, report, existing: locks[0] ?? null };
  }
  const parent = await observe(ctx, ref, { company, periods, journals, lines, accounts, intent, vat });
  const observedSources = [parent];
  for (const period of periods) if (ref.entityType !== 'fiscal_period' || period.id !== ref.entityId) {
    observedSources.push(await observe(ctx, { entityType: 'fiscal_period', entityId: String(period.id) }, { period }));
  }
  if (ref.expectedVersion !== undefined && ref.expectedVersion !== parent.version) throw new Error('Period operation version changed');
  return { supplierId: '', observedSources, versionBasis: observedSources.every(row => row.tracked)
    ? 'recorded_with_current_fingerprint' : 'untracked_current_observation',
    binding: { companyId, operation: ref.operation, entityType: ref.entityType, entityId: ref.entityId,
      entityVersion: parent.version, accountingDate: end, amount: null, currency: null, beneficiaries: [],
      sourceVersions: observedSources.map(({ facts: _facts, tracked: _tracked, ...source }) => source) } };
}
function date(value: unknown): string {
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const result = String(value).slice(0, 10);
  if (!isRealCalendarDate(result)) throw new Error('Invalid period date');
  return result;
}
