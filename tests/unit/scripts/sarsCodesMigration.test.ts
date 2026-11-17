/**
 * Migration 999m is generated, not hand-written: regenerating it from the two committed workbooks must reproduce the
 * committed file byte for byte, and the file must keep the properties the deploy relies on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSarsCodesXlsxFile } from '../../../src/modules/admin/services/sarsCodesParser';
import { buildSarsCodesMigration, SARS_MIGRATION_SOURCES, QUALITY_CHECK_SOURCES, loadOverrides } from '../../../scripts/emit-sars-codes-migration';

const ROOT = resolve(__dirname, '../../..');
const committed = readFileSync(resolve(ROOT, 'scripts/migrations/sql/999m_sars_source_codes_2024_2025.sql'), 'utf8');

/** A BRS description ends in its treatment tag: (PAYE), (IT), (Excl) or a conditional (Excl if … PAYE if …). */
const TAG = /\((PAYE|IT|Excl)( if [^()]*)?\)$/;
/** A heading never stops on one of these words just before its tag ('Transfer of (PAYE)'). */
const DANGLING = /\b(of|to|and|or|the|a|an|in|from|for|by|with|on|at|as|i\.r\.o\.|–|-|\/)\s+\((PAYE|IT|Excl)( if [^()]*)?\)$/i;
/**
 * The only descriptions the BRS itself gives without a trailing tag: the 4xxx deductions, 3835's 'Long Service Award',
 * the 3902-3905 '(PAYE) – …' accrual forms, and the 3696-3699 gross remuneration totals (section 6.5, no treatment).
 */
function untaggedAllowed(code: string, d: string): boolean {
  return code.startsWith('4') || (code === '3835' && d === 'Long Service Award')
    || (/^390[2-5]$/.test(code) && /\(PAYE\) – \S/.test(d)) || /^369[6-9]$/.test(code);
}
function descriptionProblem(code: string, d: string): string | null {
  const opens = (d.match(/\(/g) ?? []).length;
  if (d === 'null') return 'literal null';
  if (opens !== (d.match(/\)/g) ?? []).length) return `unbalanced parentheses: ${JSON.stringify(d)}`;
  if ((d.match(/“/g) ?? []).length !== (d.match(/”/g) ?? []).length) return `unpaired quote: ${JSON.stringify(d)}`;
  // ’ doubles as the apostrophe (Director’s), so pair each ‘ with a later ’ instead of counting.
  if (/‘[^’]*$/.test(d) || (d.match(/‘/g) ?? []).length > (d.match(/’/g) ?? []).length) return `unpaired quote: ${JSON.stringify(d)}`;
  if (DANGLING.test(d)) return `heading cut before its tag: ${JSON.stringify(d)}`;
  if (/\/\s*$/.test(d)) return `trailing slash: ${JSON.stringify(d)}`;
  if (/\s[b-z]\s/.test(d)) return `word cut mid-phrase: ${JSON.stringify(d)}`;
  if (/^[‘’'"]/.test(d)) return `stray leading quote: ${JSON.stringify(d)}`;
  if (/\b(\w+) \1\b/i.test(d)) return `repeated word: ${JSON.stringify(d)}`;
  if (!TAG.test(d) && !untaggedAllowed(code, d)) return `no treatment tag: ${JSON.stringify(d)}`;
  return null;
}

describe('999m sars_source_codes 2024/2025 migration', () => {
  it('regenerates byte for byte from the committed workbooks', async () => {
    expect(await buildSarsCodesMigration(ROOT)).toBe(committed);
  });

  it('holds 129 rows for 2024 and 131 for 2025, with the BRS-correct 4003/4005/4006', async () => {
    const counts = SARS_MIGRATION_SOURCES.map((s) => s.year);
    expect(counts).toEqual([2024, 2025]);
    for (const code of ['4003', '4005', '4006']) expect(committed).toContain(`('${code}', 2024,`);
    expect(committed.match(/\('\d{4}', 2024,/g)).toHaveLength(129);
    expect(committed.match(/\('\d{4}', 2025,/g)).toHaveLength(131);
  });

  it('is an idempotent upsert that never touches is_current and is not a definer', () => {
    expect(committed).toContain('ON CONFLICT (code, effective_year) DO UPDATE');
    expect(committed).toContain('ON CONFLICT (effective_year) DO UPDATE');
    expect(committed).toContain('IS DISTINCT FROM');
    expect(committed).not.toMatch(/SECURITY DEFINER/i);
    expect(committed).not.toMatch(/is_current\s*=/i);
    expect(committed).not.toMatch(/^(DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT)\b/im);
  });

  it('sets the release notes and date from the BRS, no longer the legacy-seed note, and guards on them', () => {
    expect(committed.slice(committed.indexOf('INSERT INTO sars_code_releases'))).not.toMatch(/legacy/i);
    expect(committed).toContain("(2024, 'v22.1.2', '2023-08-08 00:00:00+02', 'SARS PAYE Employer Reconciliation BRS V22.1.2");
    expect(committed).toContain("(2025, 'v23.0.0', '2024-03-08 00:00:00+02', 'SARS PAYE Employer Reconciliation BRS V23.0.0");
    expect(committed).toMatch(/DO UPDATE SET\s+brs_version = EXCLUDED\.brs_version, released_at = EXCLUDED\.released_at, notes = EXCLUDED\.notes\s+WHERE \(sars_code_releases\.brs_version, sars_code_releases\.released_at, sars_code_releases\.notes\)\s+IS DISTINCT FROM \(EXCLUDED\.brs_version, EXCLUDED\.released_at, EXCLUDED\.notes\)/);
  });

  it('corrects 2026 and 2027 descriptions with a description-only UPDATE', () => {
    const upd = committed.slice(committed.indexOf('UPDATE sars_source_codes'));
    expect(upd).toMatch(/SET description = v\.description\s+FROM \(VALUES/);
    expect(upd).toMatch(/t\.description IS DISTINCT FROM v\.description/);
    expect(upd).toContain("('3835', 2026, 'Long Service Award')");
    expect(upd).toContain("('3926', 2027, 'Savings withdrawal benefit (PAYE)')");
    expect(upd).not.toMatch(/SET [^\n]*,/);
    expect(upd).not.toMatch(/2024|2025/);
  });

  it('leaves no fragment description in any of the four years once the overrides are applied', async () => {
    const overrides = loadOverrides(ROOT);
    const problems: string[] = [];
    for (const s of QUALITY_CHECK_SOURCES) {
      const { rows } = await parseSarsCodesXlsxFile(resolve(ROOT, s.file));
      for (const r of rows) {
        const why = descriptionProblem(r.code, overrides[String(s.year)]?.[r.code]?.description ?? r.description);
        if (why) problems.push(`${s.year} ${r.code}: ${why}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the description check rejects the fragment shapes the reviews found', () => {
    expect(descriptionProblem('3923', 'Transfer of Unclaimed')).toMatch(/treatment tag/);
    expect(descriptionProblem('3809', 'Taxable Bursaries or scholarships to a non-disabled person')).toMatch(/treatment tag/);
    expect(descriptionProblem('3601', 'Income excluding any Long Service Cash Award, required to be declared under code (Subject to PAYE)')).toMatch(/treatment tag/);
    expect(descriptionProblem('3923', 'Transfer of (PAYE)')).toMatch(/cut before its tag/);
    expect(descriptionProblem('3620', 'NED Directors ‘remuneration (IT)')).toMatch(/quote/);
    expect(descriptionProblem('4001', 'Current pension fund contributions [x]')).toBeNull();
    expect(descriptionProblem('3601', 'Income [IT]')).toMatch(/treatment tag/);
    expect(descriptionProblem('3835', 'null')).toMatch(/null/);
    expect(descriptionProblem('3602', 'Income residents that are exempt i (Non-taxable)')).toMatch(/word cut/);
    expect(descriptionProblem('3802', 'Use of motor vehicle NOT under an “operating lease (PAYE)')).toMatch(/quote/);
    expect(descriptionProblem('3915', 'Retirement /')).not.toBeNull();
    expect(descriptionProblem('3719', 'Dividends not exempt i.r.o. par (dd (PAYE)')).toMatch(/parentheses/);
    expect(descriptionProblem('3809', 'Taxable Bursaries or scholarships to a non-disabled person – Basic Education (PAYE)')).toBeNull();
    expect(descriptionProblem('3620', 'NED Directors / Audit Committee Member Fees (IT)')).toBeNull();
    expect(descriptionProblem('3622', 'Long Service Cash Award (Excl if 3622+3835 <= R 5000; PAYE if 3622+3835 > R 5000)')).toBeNull();
    expect(descriptionProblem('3902', 'Pension / RAF (PAYE) – withdrawal, accruing prior to 1 March 2009')).toBeNull();
    expect(descriptionProblem('4001', 'Current pension fund contributions')).toBeNull();
  });

  it('every override names a BRS page and only corrects codes that exist in its workbook', async () => {
    const overrides = loadOverrides(ROOT);
    for (const s of QUALITY_CHECK_SOURCES) {
      const { rows } = await parseSarsCodesXlsxFile(resolve(ROOT, s.file));
      const have = new Set(rows.map((r) => r.code));
      for (const [code, o] of Object.entries(overrides[String(s.year)] ?? {})) {
        expect(have.has(code), `${s.year} ${code}`).toBe(true);
        expect(o.page).toBeGreaterThan(0);
        expect(o.brs).toMatch(/^v\d+\.\d+\.\d+$/);
        if (o.brs !== s.brs) expect(o.note, `${s.year} ${code} cites ${o.brs}, not ${s.brs}`).toMatch(/V\d/);
        if (o.officialExcerpt) expect(s.year, `${s.year} ${code}: excerpt fixes only reach upserted years`).toBeLessThan(2026);
      }
    }
  });

  it('3622 and 3922 carry the thresholds of their own year (V25.3.0 raised them for 2027)', () => {
    const ov = loadOverrides(ROOT);
    for (const y of ['2024', '2025', '2026']) {
      expect(ov[y]!['3622']!.description).toBe('Long Service Cash Award (Excl if 3622+3835 <= R 5000; PAYE if 3622+3835 > R 5000)');
      expect(ov[y]!['3922']!.description).toBe('Compensation i.r.o. death during employment (Excl if 3922 <= R 300 000; PAYE if 3922 > R 300 000)');
    }
    expect(ov['2027']!['3622']!.description).toBe('Long Service Cash Award (Excl if 3622+3835 <= R 16000; PAYE if 3622+3835 > R 16000)');
    expect(ov['2027']!['3922']!.description).toBe('Compensation i.r.o. death during employment (Excl if 3922 <= R 800 000; PAYE if 3922 > R 800 000)');
    expect(committed).toContain("('3622', 2024, 'income', 'Long Service Cash Award (Excl if 3622+3835 <= R 5000; PAYE if 3622+3835 > R 5000)'");
    expect(committed).toContain("('3622', 2027, 'Long Service Cash Award (Excl if 3622+3835 <= R 16000; PAYE if 3622+3835 > R 16000)')");
    expect(committed).toContain("('3922', 2027, 'Compensation i.r.o. death during employment (Excl if 3922 <= R 800 000; PAYE if 3922 > R 800 000)')");
  });

  it('cleans 3623 2025 explanation column, citing V25.3.0 across versions', () => {
    const row = committed.split('\n').find((l) => l.startsWith("  ('3623', 2025,"))!;
    expect(row).toContain('settlement agreement or arbitration award or court-order that relates to previous years.');
    expect(row).not.toMatch(/years\. extending over|Labour previous years|assessment • The|\(PAYE\) employees/);
    expect(loadOverrides(ROOT)['2025']!['3623']!.note).toMatch(/not in BRS V23\.0\.0.*V25\.3\.0/);
  });
});
