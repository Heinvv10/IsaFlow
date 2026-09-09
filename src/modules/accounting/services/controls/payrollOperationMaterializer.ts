import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';
import type { ControlTx, OperationRef } from './contracts';
import type { ApMaterial, ObservedSource } from './apOperationMaterializer';
import { readControlEntityVersion } from './operationVersions';
import { lockPayrollSources, type PayrollRow } from './payrollSourceMaterial';
import { buildExactPayrollPlan } from './payrollExactPlan';
import { lastDayOfMonthIso } from '../payroll/payrollJournalParts';
import { materializeGlOperation } from './glOperationMaterializer';
export async function materializePayrollOperation(ctx: ControlTx, ref: OperationRef): Promise<ApMaterial> {
  if (ref.entityType !== 'payroll_run' || !UUID_RE.test(ref.entityId) || !['payroll_run.post','payroll_run.reopen'].includes(ref.operation)) throw new Error('Unsupported payroll operation');
  const sources = await lockPayrollSources(ctx, ref.entityId);
  const { header, company } = sources;
  if (typeof company.default_currency !== 'string' || !/^[A-Z]{3}$/.test(company.default_currency)) throw new Error('Payroll ledger currency unavailable');
  const date = lastDayOfMonthIso(Number(header.period_year), Number(header.period_month));
  if (!isRealCalendarDate(date)) throw new Error('Invalid payroll period');
  const requested = ref.reversalDate;
  if (requested !== undefined && (ref.operation !== 'payroll_run.reopen' || !isRealCalendarDate(requested))) throw new Error('Invalid payroll reversal date');
  let accountingDate = date;
  let journal: ApMaterial | null = null;
  if (header.journal_entry_id) {
    journal = await materializeGlOperation(ctx, { entityType:'journal_entry',entityId:String(header.journal_entry_id),
      operation: ref.operation === 'payroll_run.reopen' ? 'journal.reverse' : 'journal.post',
      ...(requested === undefined ? {} : { reversalDate:requested }) });
    if (ref.operation === 'payroll_run.reopen') accountingDate = journal.binding.accountingDate!;
  } else if (requested !== undefined && requested !== date) throw new Error('No payroll journal to reverse');
  const periods = await ctx.sql`SELECT id,start_date::text,end_date::text,status FROM fiscal_periods
    WHERE company_id=${ctx.principal.companyId}::uuid AND start_date<=${accountingDate}::date AND end_date>=${accountingDate}::date
    ORDER BY id FOR SHARE` as PayrollRow[];
  if (periods.length !== 1) throw new Error('Payroll fiscal period missing or ambiguous');
  const plan = buildExactPayrollPlan(header,sources.lines,sources.accounts,sources.employees,sources.allocations,sources.mappings);
  const facts = { ...sources, plan, targetPeriod:periods[0]!, accountingDate,
    journal:journal ? journal.observedSources.find(s=>s.entityType==='journal_entry')!.facts : null };
  const prior = await readControlEntityVersion(ctx, ref);
  const observed: ObservedSource = { entityType:ref.entityType,entityId:ref.entityId,version:prior?.version ?? 1,
    tracked:prior !== null,fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex'),facts };
  if (ref.expectedVersion !== undefined && ref.expectedVersion !== observed.version) throw new Error('Payroll version changed');
  return { supplierId:'',observedSources:[observed],versionBasis:prior ? 'recorded_with_current_fingerprint':'untracked_current_observation',
    binding:{companyId:ctx.principal.companyId,operation:ref.operation,entityType:ref.entityType,entityId:ref.entityId,
      entityVersion:observed.version,accountingDate,amount:plan.amount,currency:company.default_currency,beneficiaries:[],
      sourceVersions:[{entityType:observed.entityType,entityId:observed.entityId,version:observed.version,fingerprint:observed.fingerprint}]} };
}
