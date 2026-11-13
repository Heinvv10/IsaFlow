/**
 * The derive service's DB adapter (P6 spec §4 "Derived defaults", T11): gathers
 * the company's VAT settings and entity type, the opening balances, the
 * trailing actuals, the VAT201 totals and the EMP201 statutory figures, and
 * hands them to the pure `deriveCore`. Computes, never writes.
 *
 * VAT totals are `getVat201Report`'s (the owner of vat.output.v1 / vat.input.v1:
 * nothing else may re-derive them) over the history window; the statutory figure
 * is `generateEMP201`'s payePayable (PAYE net of ETI, §13.12) + UIF + SDL over
 * the last three trailing months; the payable-account candidates are the active leaf liabilities.
 * `agingEvidence` adds the aged AR / AP totals
 * (shown beside the days, never used to compute them).
 */
import { sql, type DbRow } from '@/lib/neon';
import { DEFAULT_ENTITY_TYPE, ENTITY_TYPE_CODES, type EntityTypeCode } from '@/lib/entityTypes';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { isVatRegistered, normalizeVatAlignment, normalizeVatBasis, normalizeVatSetting } from '@/modules/bureau/services/vatPeriodHelper';
import { deriveCore, historyWindow, STATUTORY_MONTHS, type DeriveCompanyVat, type DerivedAssumptions } from './deriveCore';
import type { OpeningRead } from './openingBalances';
import { readActiveLeafLiabilities } from './payableAccounts';
import { monthLastDay, type ActualMonth } from './threeWayFolds';

export interface CompanyProfile {
  entityType: EntityTypeCode;
  vat: DeriveCompanyVat;
}

const cents = (rand: number): number => {
  const c = Math.round(rand * 100);
  return c === 0 ? 0 : c;
};

/** Entity type and VAT settings, normalised by `vatPeriodHelper` (alignment always through `normalizeVatAlignment`, §13.11). */
export async function readCompanyProfile(companyId: string): Promise<CompanyProfile> {
  const rows = (await sql`
    SELECT entity_type, vat_period, vat_period_alignment, vat_system_type FROM companies WHERE id = ${companyId}::UUID
  `) as DbRow[];
  const r = rows[0] ?? {};
  const raw = (v: unknown): string | null => (v == null ? null : String(v));
  const period = raw(r.vat_period);
  const system = raw(r.vat_system_type);
  const entity = raw(r.entity_type);
  const setting = normalizeVatSetting(period, system);
  return {
    entityType: (ENTITY_TYPE_CODES as readonly string[]).includes(entity ?? '') ? (entity as EntityTypeCode) : DEFAULT_ENTITY_TYPE,
    vat: {
      registered: isVatRegistered(period, system),
      cadence: setting === 'monthly' ? 'monthly' : 'bi-monthly',
      alignment: normalizeVatAlignment(raw(r.vat_period_alignment)),
      basis: normalizeVatBasis(system),
      cadenceDefaulted: period === null || period.trim() === '',
    },
  };
}

async function vatTotals(companyId: string, window: readonly ActualMonth[]): Promise<{ outputTax: number; inputTax: number } | null> {
  if (window.length === 0) return { outputTax: 0, inputTax: 0 };
  const r = await getVat201Report(companyId, `${window[0]!.month}-01`, monthLastDay(window[window.length - 1]!.month), { detail: 'summary' });
  return { outputTax: cents(r.totals.outputTax), inputTax: cents(r.totals.inputTax) };
}

async function statutory(companyId: string, trailing: readonly ActualMonth[]): Promise<number> {
  const last = trailing.slice(-STATUTORY_MONTHS);
  if (last.length === 0 || last.every((m) => m.payroll === 0)) return 0;
  const e = await generateEMP201(companyId, `${last[0]!.month}-01`, monthLastDay(last[last.length - 1]!.month));
  return cents(e.payePayable) + cents(e.totalUIF) + cents(e.totalSDL);
}

export interface DeriveSources {
  profile: CompanyProfile;
  opening: OpeningRead;
  trailing: readonly ActualMonth[];
  /** The month before the version's first month. */
  priorYearEnd: string;
}

/** The derived document for a version's year (computes, never writes). */
export async function deriveAssumptions(companyId: string, s: DeriveSources): Promise<DerivedAssumptions> {
  const window = historyWindow(s.trailing);
  return deriveCore({
    asAt: s.opening.asAt,
    priorYearEnd: s.priorYearEnd,
    entityType: s.profile.entityType,
    vat: s.profile.vat,
    opening: {
      receivables: s.opening.buckets.receivables, payables: s.opening.buckets.payables,
      inventory: s.opening.buckets.inventory, holdsInventory: s.opening.holdsInventory,
    },
    trailing: s.trailing,
    vatTotals: s.profile.vat.registered ? await vatTotals(companyId, window) : null,
    statutory: await statutory(companyId, s.trailing),
    liabilities: await readActiveLeafLiabilities(companyId),
  });
}

export interface AgingEvidence {
  /** Σ aged receivables / payables at the as-at, cents (the subledgers; evidence only). */
  receivables: number;
  payables: number;
}

export async function agingEvidence(companyId: string, asAt: string): Promise<AgingEvidence> {
  const total = (rows: ReadonlyArray<{ total: number }>) => cents(rows.reduce((t, r) => t + Number(r.total), 0));
  return { receivables: total(await getARAging(companyId, asAt)), payables: total(await getAPAging(companyId, asAt)) };
}
