/**
 * Regression: VAT201 statement timeout (post-deploy golden run, 31 Oct 2026).
 *
 * getVatPeriodLines runs as app_user under RLS. On tables with no planner
 * statistics (prod had none after the Supabase cutover) every scan is
 * estimated at one row, and the planner put company-wide scans on the inside
 * of nested loops: the inlined vat_entries subquery was re-run per (journal x
 * line) pair, over 120 s on prod for a 111-journal company.
 *
 * The fix does not leave vat_entries or the final select's join order to the
 * estimates (cancelled_entries is unchanged and still is). vat_entries is
 * MATERIALIZED and driven from the period's journals, and every other table in
 * those two is reached through an OFFSET 0 subquery keyed on the row before.
 * OFFSET 0 keeps the planner from flattening or reordering it, so the SQL text
 * fixes the join order and keys; the index stays the planner's choice.
 * A planner regression cannot be caught without data and missing
 * statistics, so this pins that shape, the tenant and period bindings, and the
 * row mapping.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from '@/lib/neon';
import { getVatPeriodLines } from '@/modules/accounting/services/reports/vatBoxBasisQuery';

const CO = '7a7473e3-a3cf-4016-aaf3-fa310d40de6e';
const FROM = '2026-03-01';
const TO = '2026-03-31';

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

async function capture(): Promise<Captured> {
  await getVatPeriodLines(CO, FROM, TO);
  expect(captured).toHaveLength(1);
  return { text: captured[0]!.text.replace(/\s+/g, ' '), values: captured[0]!.values };
}

/** The values bound to the placeholders in every match of `re` (group 1 = N of $N). */
function bound(q: Captured, re: RegExp): unknown[] {
  return [...q.text.matchAll(new RegExp(re, 'g'))].map((m) => q.values[Number(m[1]) - 1]);
}

function vatEntries(text: string): string {
  const a = text.indexOf('vat_entries AS MATERIALIZED (');
  const b = text.indexOf(', cancelled_entries_base AS (');
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
}

/** The SELECT after the last CTE: the part that used to rescan vat_entries per row. */
function finalSelect(text: string): string {
  const i = text.lastIndexOf('SELECT jl.id::TEXT');
  expect(i).toBeGreaterThan(0);
  return text.slice(i);
}

describe('getVatPeriodLines keeps vat_entries and the final select keyed', () => {
  it('materializes vat_entries so it is built once, never rescanned per row', async () => {
    expect((await capture()).text).toMatch(/WITH RECURSIVE vat_entries AS MATERIALIZED \(/);
  });

  it('builds vat_entries from the period journals, probing each journal\'s lines by key', async () => {
    const ve = vatEntries((await capture()).text);
    expect(ve).toMatch(/^vat_entries AS MATERIALIZED \( SELECT je\.id FROM gl_journal_entries je WHERE/);
    expect(ve).toMatch(/AND EXISTS \( SELECT 1 FROM gl_journal_lines jl CROSS JOIN LATERAL \( SELECT ga\.account_type, ga\.account_subtype FROM gl_accounts ga WHERE ga\.id = jl\.gl_account_id OFFSET 0 \) ga WHERE jl\.company_id = \$\d+::UUID AND jl\.journal_entry_id = je\.id/);
    expect(ve).toMatch(/OFFSET 0 \) \)\s*$/);
  });

  it('binds vat_entries to this company and period, in the right order', async () => {
    const q = await capture();
    const ve = { text: vatEntries(q.text), values: q.values };
    expect(bound(ve, /je\.company_id = \$(\d+)::UUID/)).toEqual([CO]);
    expect(bound(ve, /jl\.company_id = \$(\d+)::UUID/)).toEqual([CO]);
    expect(bound(ve, /je\.entry_date >= \$(\d+)::DATE/)).toEqual([FROM]);
    expect(bound(ve, /je\.entry_date <= \$(\d+)::DATE/)).toEqual([TO]);
  });

  it('reaches journal, lines and accounts through keyed LATERAL probes from vat_entries', async () => {
    const tail = finalSelect((await capture()).text);
    expect(tail).toMatch(/FROM vat_entries ve CROSS JOIN LATERAL \( SELECT [^)]* FROM gl_journal_entries e WHERE e\.id = ve\.id AND e\.company_id = \$\d+::UUID OFFSET 0 \) je/);
    expect(tail).toMatch(/CROSS JOIN LATERAL \( SELECT [^)]* FROM gl_journal_lines l WHERE l\.company_id = \$\d+::UUID AND l\.journal_entry_id = ve\.id OFFSET 0 \) jl/);
    expect(tail).toMatch(/CROSS JOIN LATERAL \( SELECT [^)]* FROM gl_accounts a WHERE a\.id = jl\.gl_account_id OFFSET 0 \) ga/);
    // No unkeyed company-wide join left for the planner to put on the inside.
    expect(tail).not.toMatch(/\bJOIN gl_(journal_lines|journal_entries|accounts)\b/);
  });

  it('scopes every final-select probe to this company', async () => {
    const q = await capture();
    const tail = { text: finalSelect(q.text), values: q.values };
    expect(bound(tail, /company_id = \$(\d+)::UUID/)).toEqual([CO, CO]);
  });

  it('keeps the cancelled flag as the original IN over the deduped recursive CTE', async () => {
    expect(finalSelect((await capture()).text)).toMatch(/\(je\.id IN \(SELECT id FROM cancelled_entries\)\) AS cancelled_source/);
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
    const out = await getVatPeriodLines('c1', FROM, TO);
    expect(out.lines.map((l) => [l.lineId, l.cancelledSource, l.debit, l.credit])).toEqual([
      ['l1', false, 15, 0],
      ['l2', true, 0, 15],
    ]);
    expect(out.postedThrough).toBe('2026-03-12T08:00:00.000Z');
  });
});
