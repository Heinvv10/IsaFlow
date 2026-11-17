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

  it('sets the release notes to the BRS version, no longer the legacy-seed note, and guards on them', () => {
    expect(committed.slice(committed.indexOf('INSERT INTO sars_code_releases'))).not.toMatch(/legacy/i);
    expect(committed).toContain("(2024, 'v22.1.2', now(), 'SARS PAYE Employer Reconciliation BRS V22.1.2");
    expect(committed).toContain("(2025, 'v23.0.0', now(), 'SARS PAYE Employer Reconciliation BRS V23.0.0");
    expect(committed).toMatch(/DO UPDATE SET brs_version = EXCLUDED\.brs_version, notes = EXCLUDED\.notes\s+WHERE \(sars_code_releases\.brs_version, sars_code_releases\.notes\) IS DISTINCT FROM/);
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
    const STOP = new Set(['to', 'of', 'or', 'and', 'the', 'a', 'in', 'from', 'i', 'e', 'g', 'on', 'for', 'by', 'with', '–', '-', '(subject', 'an', 'as', 'at']);
    const problems: string[] = [];
    for (const s of QUALITY_CHECK_SOURCES) {
      const { rows } = await parseSarsCodesXlsxFile(resolve(ROOT, s.file));
      for (const r of rows) {
        const d = overrides[String(s.year)]?.[r.code]?.description ?? r.description;
        const last = d.split(/\s+/).pop()!.toLowerCase();
        const why =
          d === 'null' ? 'literal null'
          : d.length < 10 ? 'too short'
          : (d.match(/\(/g) ?? []).length !== (d.match(/\)/g) ?? []).length ? 'unbalanced parentheses'
          : STOP.has(last) || /\bi\.?$/.test(d) ? 'ends mid-phrase'
          : /^[‘’'"]/.test(d) ? 'stray leading quote'
          : /\b(\w+) \1\b/i.test(d) ? 'repeated word'
          : /^Reimbursive This|Subject to .* i$/.test(d) ? 'column bleed'
          : null;
        if (why) problems.push(`${s.year} ${r.code}: ${why}: ${JSON.stringify(d)}`);
      }
    }
    expect(problems).toEqual([]);
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
      }
    }
  });
});
