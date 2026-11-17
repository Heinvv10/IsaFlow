/**
 * Migration 999m is generated, not hand-written: regenerating it from the two committed workbooks must reproduce the
 * committed file byte for byte, and the file must keep the properties the deploy relies on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSarsCodesMigration, SARS_MIGRATION_SOURCES } from '../../../scripts/emit-sars-codes-migration';

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
    expect(committed).not.toMatch(/^(DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|UPDATE)\b/im);
  });
});
