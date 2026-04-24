/**
 * Year-effective SARS source-code lookup.
 *
 * Replaces the hardcoded SARS_SOURCE_CODES map in
 * src/modules/accounting/services/reports/irp5Service.ts.
 *
 * Reads from the sars_source_codes + sars_code_releases tables
 * (migration 435_sars_source_codes.sql). In-memory cache is
 * keyed by tax year and refreshed per call to refreshCache().
 *
 * Usage:
 *   const code = await getSarsCode('3601', 2026);
 *   const allIncome = await listSarsCodes(2026, { category: 'income' });
 *   const year = await getCurrentTaxYear();
 */

import { sql } from '@/lib/neon';

export type SarsCategory =
  | 'income'
  | 'allowance'
  | 'fringe'
  | 'employer'
  | 'deduction'
  | 'lump_sum';

export type SarsStatus = 'active' | 'conditional' | 'deprecated';

export interface SarsCode {
  code: string;
  effectiveYear: number;
  category: SarsCategory;
  description: string;
  status: SarsStatus;
  foreignCode: string | null;
  codePair: string | null;
  applicabilityNote: string | null;
  rationalisationNote: string | null;
  sourceDocument: string | null;
  sourceUrl: string | null;
  officialExcerpt: string | null;
  brsVersion: string | null;
}

interface SarsCodeRow {
  code: string;
  effective_year: number;
  category: SarsCategory;
  description: string;
  status: SarsStatus;
  foreign_code: string | null;
  code_pair: string | null;
  applicability_note: string | null;
  rationalisation_note: string | null;
  source_document: string | null;
  source_url: string | null;
  official_excerpt: string | null;
  brs_version: string | null;
}

const yearCache = new Map<number, Map<string, SarsCode>>();
let currentYearCache: { year: number; loadedAt: number } | null = null;
const CURRENT_YEAR_TTL_MS = 60_000;

function rowToCode(r: SarsCodeRow): SarsCode {
  return {
    code: r.code,
    effectiveYear: r.effective_year,
    category: r.category,
    description: r.description,
    status: r.status,
    foreignCode: r.foreign_code,
    codePair: r.code_pair,
    applicabilityNote: r.applicability_note,
    rationalisationNote: r.rationalisation_note,
    sourceDocument: r.source_document,
    sourceUrl: r.source_url,
    officialExcerpt: r.official_excerpt,
    brsVersion: r.brs_version,
  };
}

async function loadYear(year: number): Promise<Map<string, SarsCode>> {
  const cached = yearCache.get(year);
  if (cached) return cached;

  const rows = (await sql`
    SELECT code, effective_year, category, description, status,
           foreign_code, code_pair, applicability_note, rationalisation_note,
           source_document, source_url, official_excerpt, brs_version
      FROM sars_source_codes
     WHERE effective_year = ${year}
  `) as unknown as SarsCodeRow[];

  const map = new Map<string, SarsCode>();
  for (const r of rows) map.set(r.code, rowToCode(r));
  yearCache.set(year, map);
  return map;
}

export function refreshCache(): void {
  yearCache.clear();
  currentYearCache = null;
}

export async function getCurrentTaxYear(): Promise<number> {
  if (currentYearCache && Date.now() - currentYearCache.loadedAt < CURRENT_YEAR_TTL_MS) {
    return currentYearCache.year;
  }
  const rows = (await sql`
    SELECT effective_year FROM sars_code_releases WHERE is_current = true LIMIT 1
  `) as unknown as Array<{ effective_year: number }>;
  if (rows.length === 0) {
    throw new Error('No SARS code release marked is_current. Run import-sars-codes.ts --set-current.');
  }
  const year = rows[0]!.effective_year;
  currentYearCache = { year, loadedAt: Date.now() };
  return year;
}

export async function getSarsCode(code: string, taxYear: number): Promise<SarsCode | null> {
  const map = await loadYear(taxYear);
  return map.get(code) ?? null;
}

export async function isKnownSarsCode(code: string, taxYear: number): Promise<boolean> {
  const map = await loadYear(taxYear);
  return map.has(code);
}

export interface ListSarsCodesOptions {
  category?: SarsCategory;
  status?: SarsStatus | SarsStatus[];
  excludeDeprecated?: boolean;
}

export async function listSarsCodes(taxYear: number, opts: ListSarsCodesOptions = {}): Promise<SarsCode[]> {
  const map = await loadYear(taxYear);
  let results = Array.from(map.values());

  if (opts.category) results = results.filter((c) => c.category === opts.category);
  if (opts.status) {
    const allowed = Array.isArray(opts.status) ? opts.status : [opts.status];
    results = results.filter((c) => allowed.includes(c.status));
  }
  if (opts.excludeDeprecated) results = results.filter((c) => c.status !== 'deprecated');

  return results.sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Maps the new fine-grained category to the coarse income/deduction/employer
 * trichotomy used by payroll_components.component_type validation.
 *
 * income | allowance | fringe | lump_sum  → "income"  (employee earnings)
 * deduction                                → "deduction"
 * employer                                 → "employer"
 */
export function categoryToComponentType(
  category: SarsCategory
): 'income' | 'deduction' | 'employer' {
  if (category === 'deduction') return 'deduction';
  if (category === 'employer') return 'employer';
  return 'income';
}
