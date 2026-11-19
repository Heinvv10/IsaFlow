/**
 * Every writer of stock_movements / stock_levels names company_id (migration 1005 gave both tables the column and RLS). A
 * BEFORE INSERT trigger fills a missing one from the product, so a writer that forgets it still works, but only for a product
 * that has a company: this census keeps new writers explicit (the old one, POST /stock-adjustments, and the demo seeder were
 * fixed to). Text census over the source tree on disk, migrations (which define the trigger) and tests excluded.
 */
import { describe, expect, it } from 'vitest';
import { sourceFiles } from '../../helpers/sourceCensus';

const INSERT = /INSERT\s+INTO\s+(?:public\.)?(stock_movements|stock_levels)\s*\(([^)]*)\)/gi;

describe('stock writers name company_id', () => {
  it('has writers to judge (the census is not vacuous)', () => {
    const writers = sourceFiles().filter((f) => !f.file.startsWith('scripts/migrations/') && INSERT.test(f.text));
    INSERT.lastIndex = 0;
    expect(writers.map((f) => f.file)).toEqual(expect.arrayContaining(['pages/api/accounting/stock-adjustments.ts', 'scripts/seed-historical-data.mjs']));
  });

  it('every INSERT INTO stock_movements / stock_levels lists company_id', () => {
    const bad: string[] = [];
    for (const { file, text } of sourceFiles()) {
      if (file.startsWith('scripts/migrations/')) continue;
      for (const m of text.matchAll(INSERT)) if (!/\bcompany_id\b/.test(m[2]!)) bad.push(`${file}: INSERT INTO ${m[1]} (${m[2]!.trim().slice(0, 60)}…)`);
    }
    expect(bad).toEqual([]);
  });
});
