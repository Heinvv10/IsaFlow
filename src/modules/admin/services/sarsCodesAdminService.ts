/**
 * Admin operations for SARS source codes — list, import, set-current,
 * deprecate. Tenants only ever read codes via sarsCodesService; mutation
 * always goes through this admin-side service so audit logging is uniform.
 */

import { sql } from '@/lib/neon';
import { refreshCache } from '@/modules/accounting/services/payroll/sarsCodesService';
import type { ParsedSarsRow } from './sarsCodesParser';

export interface SarsCodeAdminRow {
  code: string;
  effective_year: number;
  category: string;
  description: string;
  status: string;
  foreign_code: string | null;
  code_pair: string | null;
  applicability_note: string | null;
  source_document: string | null;
  source_url: string | null;
  official_excerpt: string | null;
  brs_version: string | null;
  imported_at: Date | string;
  used_by_companies: number;
}

export interface SarsReleaseRow {
  effective_year: number;
  brs_version: string;
  released_at: Date | string;
  is_current: boolean;
  notes: string | null;
  code_count: number;
}

export interface ImportDiff {
  added: string[];
  removed: string[];
  changed: { code: string; field: string; oldValue: string | null; newValue: string | null }[];
}

export interface ImportResult {
  effectiveYear: number;
  brsVersion: string;
  upserted: number;
  diff: ImportDiff;
  setCurrent: boolean;
}

export async function listReleases(): Promise<SarsReleaseRow[]> {
  const rows = (await sql`
    SELECT r.effective_year, r.brs_version, r.released_at, r.is_current, r.notes,
           (SELECT COUNT(*)::int FROM sars_source_codes c WHERE c.effective_year = r.effective_year) AS code_count
      FROM sars_code_releases r
     ORDER BY r.effective_year DESC
  `) as unknown as SarsReleaseRow[];
  return rows;
}

export async function listCodes(taxYear: number, opts: {
  search?: string;
  category?: string;
  status?: string;
} = {}): Promise<SarsCodeAdminRow[]> {
  const search = opts.search?.trim() ?? '';
  const category = opts.category?.trim() ?? '';
  const status = opts.status?.trim() ?? '';

  const rows = (await sql`
    SELECT c.code, c.effective_year, c.category, c.description, c.status,
           c.foreign_code, c.code_pair, c.applicability_note,
           c.source_document, c.source_url, c.official_excerpt,
           c.brs_version, c.imported_at,
           (SELECT COUNT(DISTINCT pc.company_id)::int
              FROM payroll_components pc
             WHERE pc.sars_source_code = c.code) AS used_by_companies
      FROM sars_source_codes c
     WHERE c.effective_year = ${taxYear}
       AND (${search} = '' OR c.code ILIKE ${'%' + search + '%'} OR c.description ILIKE ${'%' + search + '%'})
       AND (${category} = '' OR c.category = ${category})
       AND (${status} = '' OR c.status = ${status})
     ORDER BY c.code
  `) as unknown as SarsCodeAdminRow[];
  return rows;
}

export async function diffAgainstYear(rows: ParsedSarsRow[], priorYear: number): Promise<ImportDiff> {
  const prior = (await sql`
    SELECT code, category, description, status
      FROM sars_source_codes
     WHERE effective_year = ${priorYear}
  `) as unknown as Array<{ code: string; category: string; description: string; status: string }>;

  const priorMap = new Map(prior.map((p) => [p.code, p]));
  const newMap = new Map(rows.map((r) => [r.code, r]));

  const added = rows.filter((r) => !priorMap.has(r.code)).map((r) => r.code);
  const removed = [...priorMap.keys()].filter((c) => !newMap.has(c));
  const changed: ImportDiff['changed'] = [];

  for (const r of rows) {
    const old = priorMap.get(r.code);
    if (!old) continue;
    if (old.description !== r.description) {
      changed.push({ code: r.code, field: 'description', oldValue: old.description, newValue: r.description });
    }
    if (old.category !== r.category) {
      changed.push({ code: r.code, field: 'category', oldValue: old.category, newValue: r.category });
    }
    if (old.status !== r.status) {
      changed.push({ code: r.code, field: 'status', oldValue: old.status, newValue: r.status });
    }
  }

  return { added, removed, changed };
}

export async function importRows(opts: {
  rows: ParsedSarsRow[];
  effectiveYear: number;
  brsVersion: string;
  setCurrent: boolean;
  importedBy: string;
}): Promise<ImportResult> {
  const diff = await diffAgainstYear(opts.rows, opts.effectiveYear - 1);

  let upserted = 0;
  for (const r of opts.rows) {
    await sql`
      INSERT INTO sars_source_codes (
        code, effective_year, category, description, status,
        foreign_code, code_pair, applicability_note, rationalisation_note,
        source_document, source_url, official_excerpt, brs_version, imported_by
      ) VALUES (
        ${r.code}, ${opts.effectiveYear}, ${r.category}, ${r.description}, ${r.status},
        ${r.foreignCode}, ${r.codePair}, ${r.applicabilityNote}, ${r.rationalisationNote},
        ${r.sourceDocument}, ${r.sourceUrl}, ${r.officialExcerpt}, ${opts.brsVersion}, ${opts.importedBy}
      )
      ON CONFLICT (code, effective_year) DO UPDATE SET
        category = EXCLUDED.category,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        foreign_code = EXCLUDED.foreign_code,
        code_pair = EXCLUDED.code_pair,
        applicability_note = EXCLUDED.applicability_note,
        rationalisation_note = EXCLUDED.rationalisation_note,
        source_document = EXCLUDED.source_document,
        source_url = EXCLUDED.source_url,
        official_excerpt = EXCLUDED.official_excerpt,
        brs_version = EXCLUDED.brs_version,
        imported_at = now(),
        imported_by = EXCLUDED.imported_by
    `;
    upserted++;
  }

  if (opts.setCurrent) {
    await sql`UPDATE sars_code_releases SET is_current = false WHERE is_current = true`;
  }
  await sql`
    INSERT INTO sars_code_releases (effective_year, brs_version, released_at, is_current)
    VALUES (${opts.effectiveYear}, ${opts.brsVersion}, now(), ${opts.setCurrent})
    ON CONFLICT (effective_year) DO UPDATE SET
      brs_version = EXCLUDED.brs_version,
      is_current = ${opts.setCurrent} OR sars_code_releases.is_current
  `;

  refreshCache();

  return {
    effectiveYear: opts.effectiveYear,
    brsVersion: opts.brsVersion,
    upserted,
    diff,
    setCurrent: opts.setCurrent,
  };
}

export async function setCurrentRelease(effectiveYear: number): Promise<void> {
  await sql`UPDATE sars_code_releases SET is_current = false WHERE is_current = true`;
  const updated = (await sql`
    UPDATE sars_code_releases SET is_current = true WHERE effective_year = ${effectiveYear}
    RETURNING effective_year
  `) as unknown as Array<{ effective_year: number }>;
  if (updated.length === 0) {
    throw new Error(`No release found for tax year ${effectiveYear}`);
  }
  refreshCache();
}

export async function deprecateCode(code: string, effectiveYear: number): Promise<void> {
  const updated = (await sql`
    UPDATE sars_source_codes SET status = 'deprecated'
     WHERE code = ${code} AND effective_year = ${effectiveYear}
    RETURNING code
  `) as unknown as Array<{ code: string }>;
  if (updated.length === 0) {
    throw new Error(`Code ${code} not found for tax year ${effectiveYear}`);
  }
  refreshCache();
}

export async function restoreCode(code: string, effectiveYear: number): Promise<void> {
  const updated = (await sql`
    UPDATE sars_source_codes SET status = 'active'
     WHERE code = ${code} AND effective_year = ${effectiveYear}
    RETURNING code
  `) as unknown as Array<{ code: string }>;
  if (updated.length === 0) {
    throw new Error(`Code ${code} not found for tax year ${effectiveYear}`);
  }
  refreshCache();
}
