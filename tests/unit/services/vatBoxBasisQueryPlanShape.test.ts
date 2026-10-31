/**
 * Regression: VAT201 statement timeout (post-deploy golden run, 31 Oct 2026).
 *
 * getVatPeriodLines runs as app_user under RLS. On a table with no planner
 * statistics (prod had none after the Supabase cutover) every scan is estimated
 * at one row, and with vat_entries inlined the planner re-ran the whole
 * membership subquery once per (journal x company line) pair: 111 journals and
 * 296 lines took over 120 s on prod, and 12 s on a 65-journal never-analyzed
 * dev copy. The rewritten query took 5 ms on prod and 1.7 ms on that copy.
 *
 * A planner regression cannot be caught without the data, so this pins the
 * SQL shape that keeps the plan linear whatever the statistics say, plus the
 * row mapping the rewrite touched (cancelled_source).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from '@/lib/neon';
import { getVatPeriodLines } from '@/modules/accounting/services/reports/vatBoxBasisQuery';

type Captured = { text: string; values: unknown[] };
let captured: Captured[] = [];
let rows: Record<string, unknown>[] = [];
// The barrel does not export LazyQuery (R-184), so take its prototype from an
// unawaited query; nothing below ever reaches the database.
const proto = Object.getPrototypeOf(sql`SELECT 1`) as { then: (...a: unknown[]) => unknown };
const realThen = proto.then;

beforeEach(() => {
  captured = [];
  rows = [];
  proto.then = function (this: { text: string; values: unknown[] }, res: unknown, rej: unknown) {
    captured.push({ text: this.text, values: this.values });
    return Promise.resolve(rows).then(res as never, rej as never);
  };
});
afterEach(() => { proto.then = realThen; });

async function capture(): Promise<string> {
  await getVatPeriodLines('7a7473e3-a3cf-4016-aaf3-fa310d40de6e', '2026-03-01', '2026-03-31');
  expect(captured).toHaveLength(1);
  return captured[0]!.text.replace(/\s+/g, ' ');
}

/** The SELECT after the last CTE: the part that used to rescan vat_entries per row. */
function finalSelect(text: string): string {
  const i = text.lastIndexOf('SELECT jl.id::TEXT');
  expect(i).toBeGreaterThan(0);
  return text.slice(i);
}

describe('getVatPeriodLines keeps a statistics-proof plan shape', () => {
  it('materializes vat_entries so it is built once, never rescanned per row', async () => {
    expect(await capture()).toMatch(/WITH RECURSIVE vat_entries AS MATERIALIZED \(/);
  });

  it('drives the final query from vat_entries by key', async () => {
    const tail = finalSelect(await capture());
    expect(tail).toMatch(/FROM vat_entries ve JOIN gl_journal_entries je ON je\.id = ve\.id JOIN gl_journal_lines jl ON jl\.journal_entry_id = ve\.id/);
  });

  it('bounds the final query to the period', async () => {
    const tail = finalSelect(await capture());
    expect(tail).toMatch(/je\.entry_date >= \$\d+::DATE/);
    expect(tail).toMatch(/je\.entry_date <= \$\d+::DATE/);
  });

  it('flags cancelled sources with a join, not a per-row subplan', async () => {
    const tail = finalSelect(await capture());
    expect(tail).not.toMatch(/IN \(SELECT id FROM cancelled_entries\)/);
    expect(tail).toMatch(/LEFT JOIN cancelled_entries ce ON ce\.id = je\.id/);
    expect(tail).toMatch(/\(ce\.id IS NOT NULL\) AS cancelled_source/);
  });

  it('maps rows unchanged, including cancelled_source and postedThrough', async () => {
    const base = {
      journal_entry_id: 'j1', entry_number: 'J-1', entry_date: '2026-03-10', account_id: 'a1',
      account_code: '1100', account_name: 'VAT Input', account_type: 'asset', account_subtype: 'vat_input',
      vat_type: 'standard', entry_source: 'manual', reversal_of_id: null, late_claim_base: null, debit: '15', credit: '0',
    };
    rows = [
      { ...base, line_id: 'l1', row_created_at: '2026-03-10T08:00:00.000Z', cancelled_source: false },
      { ...base, line_id: 'l2', row_created_at: '2026-03-12T08:00:00.000Z', cancelled_source: true, debit: '0', credit: '15' },
    ];
    const out = await getVatPeriodLines('c1', '2026-03-01', '2026-03-31');
    expect(out.lines.map((l) => [l.lineId, l.cancelledSource, l.debit, l.credit])).toEqual([
      ['l1', false, 15, 0],
      ['l2', true, 0, 15],
    ]);
    expect(out.postedThrough).toBe('2026-03-12T08:00:00.000Z');
  });
});
