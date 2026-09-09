import { createHash } from 'node:crypto';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';
import { assertControlTx } from './context';
import { canonicalJson } from './canonical';
import { readControlEntityVersion } from './operationVersions';
import { calculateExactDepreciation } from '../gl/glBypassExactPlans';
import type { ControlTx, OperationRef } from './contracts';
import type { ApMaterial, ObservedSource } from './apOperationMaterializer';
type Row = Record<string, unknown>;

export async function materializeAssetDepreciationOperation(ctx: ControlTx, ref: OperationRef): Promise<ApMaterial> {
  assertControlTx(ctx);
  if (ref.entityType !== 'asset_depreciation_intent' || !UUID_RE.test(ref.entityId)
    || !['asset_depreciation.post'].includes(ref.operation)) throw new Error('Unsupported depreciation operation');
  const companyId = ctx.principal.companyId;
  const [company] = await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text
    FROM companies WHERE id=${companyId}::uuid FOR SHARE` as Row[];
  const [intent] = await ctx.sql`SELECT id,requester_person_id,asset_id,period_date::text
    FROM control_asset_depreciation_intents WHERE company_id=${companyId}::uuid AND id=${ref.entityId}::uuid FOR UPDATE` as Row[];
  if (!company || !intent) throw new Error('Depreciation operation not found');
  const currency = company.default_currency, date = intent.period_date;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || typeof date !== 'string' || !isRealCalendarDate(date)) {
    throw new Error('Asset ledger currency or period unavailable');
  }
  const [asset] = await ctx.sql`SELECT *,purchase_date::text,disposal_date::text FROM assets
    WHERE company_id=${companyId}::uuid AND id=${intent.asset_id}::uuid FOR UPDATE` as Row[];
  if (!asset) throw new Error('Asset not found');
  // asset_categories is a shared global policy catalogue (migration 244), not a tenant table.
  const [category] = asset.category_id ? await ctx.sql`SELECT id,useful_life_years,residual_pct,tax_life_years,is_active
    FROM asset_categories WHERE id=${asset.category_id}::uuid FOR SHARE` as Row[] : [];
  if (asset.category_id && !category) throw new Error('Asset category unavailable');
  const ledgers = await ctx.sql`SELECT *,period_date::text FROM asset_period_ledger
    WHERE company_id=${companyId}::uuid AND asset_id=${asset.id}::uuid ORDER BY yyyymm,id LIMIT 10001 FOR SHARE` as Row[];
  if (ledgers.length > 10000) throw new Error('Asset ledger history exceeds synchronous limit');
  const periodKey = date.slice(0, 7).replace('-', '');
  const target = ledgers.find(row => String(row.yyyymm) === periodKey);
  if (ledgers.some(row => String(row.yyyymm) > periodKey)) throw new Error('Later depreciation periods require explicit correction first');
  const input = {
    cost: String(asset.purchase_price), residualPct: String(category?.residual_pct ?? '0'),
    usefulLifeYears: String(asset.useful_life_years ?? category?.useful_life_years ?? '0'),
    taxLifeYears: String(asset.tax_useful_life_years ?? category?.tax_life_years ?? asset.useful_life_years ?? category?.useful_life_years ?? '0'),
    openingAccDep: String(target?.policy_opening_acc_dep ?? asset.accumulated_depreciation ?? '0'),
    taxOpeningAccDep: String(target?.tax_opening_acc_dep ?? asset.tax_accumulated_depreciation ?? '0'),
    deferredTaxRate: String(asset.deferred_tax_rate ?? '0.27'), purchaseDate: String(asset.purchase_date), periodDate: date,
    ...(asset.salvage_value === null || asset.salvage_value === undefined ? {} : { salvageValue: String(asset.salvage_value) }),
    ...(asset.disposal_date ? { disposalDate: String(asset.disposal_date) } : {}),
  };
  const calculation = calculateExactDepreciation(input);
  const accounts = await ctx.sql`SELECT id,account_code,account_name,account_type,account_subtype,is_active,is_system_account
    FROM gl_accounts WHERE company_id=${companyId}::uuid AND is_system_account=true
      AND account_subtype IN ('depreciation_expense','accumulated_depreciation') ORDER BY id LIMIT 3 FOR SHARE` as Row[];
  const expense = accounts.filter(a => a.account_subtype === 'depreciation_expense' && a.account_type === 'expense');
  const accumulated = accounts.filter(a => a.account_subtype === 'accumulated_depreciation' && a.account_type === 'asset');
  if (accounts.length !== 2 || expense.length !== 1 || accumulated.length !== 1) throw new Error('Depreciation account roles missing or ambiguous');
  const periods = await ctx.sql`SELECT id,start_date::text,end_date::text,status FROM fiscal_periods
    WHERE company_id=${companyId}::uuid AND start_date<=${date}::date AND end_date>=${date}::date ORDER BY id FOR SHARE` as Row[];
  if (periods.length !== 1) throw new Error('Depreciation fiscal period missing or ambiguous');
  const plan = calculation.policyDep === '0' ? [] : [
    { glAccountId: String(expense[0]!.id), debit: calculation.policyDep, credit: '0' },
    { glAccountId: String(accumulated[0]!.id), debit: '0', credit: calculation.policyDep },
  ];
  const facts = { company, intent, asset, category: category ?? null, ledgers, input, calculation, accounts, period: periods[0]!, plan };
  const prior = await readControlEntityVersion(ctx, ref);
  const observed: ObservedSource = { entityType: ref.entityType, entityId: ref.entityId, version: prior?.version ?? 1,
    tracked: prior !== null, facts, fingerprint: createHash('sha256').update(canonicalJson(facts)).digest('hex') };
  if (ref.expectedVersion !== undefined && ref.expectedVersion !== observed.version) throw new Error('Depreciation version changed');
  return { supplierId: '', observedSources: [observed], versionBasis: prior ? 'recorded_with_current_fingerprint' : 'untracked_current_observation',
    binding: { companyId, operation: ref.operation, entityType: ref.entityType, entityId: ref.entityId, entityVersion: observed.version,
      accountingDate: date, amount: calculation.policyDep, currency, beneficiaries: [], sourceVersions: [{ entityType: ref.entityType,
        entityId: ref.entityId, version: observed.version, fingerprint: observed.fingerprint }] } };
}
