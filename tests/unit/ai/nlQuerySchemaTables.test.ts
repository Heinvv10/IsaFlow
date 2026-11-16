/**
 * Every table the NL-query prompt lists must show `company_id` when the table has it: the prompt asks the model to filter
 * on it, and the tenant guard refuses a query that leaves an alias unseeded. Read from the committed schema baseline.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { SCHEMA_TABLES } from '@/modules/accounting/services/core/nlQuerySchemaTables';

const baseline = gunzipSync(readFileSync('scripts/ci/integration/baseline.sql.gz')).toString('utf8');

function baselineColumns(table: string): string[] | null {
  const m = new RegExp(`CREATE (?:TABLE|VIEW) public\\.${table}\\b([\\s\\S]*?)(?:\\n\\);|;\\n)`).exec(baseline);
  return m ? [...m[1]!.matchAll(/^\s+"?(\w+)"?\s+[a-z]/gm)].map((x) => x[1]!) : null;
}

describe('NL-query schema text', () => {
  it('lists company_id for every table that has the column', () => {
    const checked: string[] = [];
    const omitted: string[] = [];
    for (const t of SCHEMA_TABLES) {
      const cols = baselineColumns(t.name);
      if (!cols) continue; // not in the schema (a stale name): nothing to compare
      checked.push(t.name);
      if (cols.includes('company_id') && !t.columns.includes('company_id')) omitted.push(t.name);
    }
    expect(checked.length).toBeGreaterThan(8);
    expect(omitted).toEqual([]);
  });

  it('names the three tables that used to omit it', () => {
    for (const name of ['gl_journal_entries', 'gl_journal_lines', 'projects']) {
      expect(SCHEMA_TABLES.find((t) => t.name === name)?.columns).toContain('company_id');
    }
  });
});
