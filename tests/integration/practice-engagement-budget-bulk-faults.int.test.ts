// tests/integration/practice-engagement-budget-bulk-faults.int.test.ts
//
// Bulk fill-from-template under REAL Postgres errors, injected on one date:
// - a server fault (57014, statement timeout) on date 2 of 3 is not a quiet
//   201. The service re-throws it, the route re-throws it (a 4xx would make
//   withAuth COMMIT date 1), withErrorHandler answers 500, and nothing of the
//   range is written. The route logs the cause at error.
// - a data error (22012) in date 2's validation read is that date's failure
//   only: date 2's own savepoint rolls it back, so dates 1 and 3 are written
//   rather than date 3 dying on 25P02.
// The fault runs a real failing statement through the original `sql` inside
// the caller's transaction — not a synthetic throw — so the transaction state
// is what Postgres would leave. Fixture: practice-engagement-budget.helpers.ts.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';

const fault = vi.hoisted(() => ({ match: '', onCall: 0, seen: 0, kind: '' as '' | 'timeout' | 'div0' }));
vi.mock('@/lib/neon', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/neon')>();
  const call = orig.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
  const wrapped = (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    if (fault.match && strings.join('?').includes(fault.match) && ++fault.seen === fault.onCall) {
      if (fault.kind === 'timeout') {
        await orig.sql`SET LOCAL statement_timeout = '50ms'`;
        await orig.sql`SELECT pg_sleep(1)`;
      } else {
        await orig.sql`SELECT 1 / 0`;
      }
    }
    return call(strings, ...vals);
  }) as unknown as typeof orig.sql;
  Object.assign(wrapped, orig.sql);
  return { ...orig, sql: wrapped, default: wrapped };
});

import { log } from '@/lib/logger';
import bulkRoute from '../../pages/api/accounting/practice/time-entries/bulk';
import { createEbFixture, ebDbAvailable, type EbFixture } from './practice-engagement-budget.helpers';

const describeIfDb = ebDbAvailable ? describe : describe.skip;

describeIfDb('Engagement budgets — bulk fill under real Postgres errors', () => {
  let f: EbFixture;
  let tpl = '';
  const arm = (match: string, kind: 'timeout' | 'div0') => Object.assign(fault, { match, onCall: 2, seen: 0, kind });
  const disarm = () => Object.assign(fault, { match: '', onCall: 0, seen: 0, kind: '' });
  const fill = () => f.call(bulkRoute, 'POST', { templateId: tpl, dateFrom: '2026-01-05', dateTo: '2026-01-07', weekdays: [1, 2, 3] });

  beforeAll(async () => {
    f = await createEbFixture('EBQ');
    tpl = randomUUID();
    await f.pool.query(
      `INSERT INTO practice_entry_templates (id, company_id, user_id, name, practice_client_id, job_category_id,
         work_item_id, default_hours, task_description, billable)
       VALUES ($1, $2, $3, 'EBQ tpl', $4, $5, $6, 2, 'EBQ bulk', true)`,
      [tpl, f.A, f.USER, f.CLIENT, f.CAT, f.ITEM]);
  });
  afterAll(async () => { disarm(); if (f) await f.cleanup(); });

  it('a statement timeout on date 2 of 3 answers 500, writes nothing, and logs the cause', async () => {
    const errSpy = vi.spyOn(log, 'error');
    arm('INSERT INTO time_entries', 'timeout');
    let r; let fired = 0;
    try { r = await fill(); fired = fault.seen; } finally { disarm(); }
    expect(fired).toBe(2); // date 1 inserted, date 2 faulted, date 3 never reached
    expect(r.statusCode, JSON.stringify(r.body)).toBe(500);
    expect(await f.entriesNamed('EBQ bulk')).toBe(0);
    const causes = errSpy.mock.calls.filter((c) => c[0] === 'Practice bulk create from template failed')
      .map((c) => (c[1] as { error?: { code?: string } }).error?.code);
    errSpy.mockRestore();
    expect(causes).toEqual(['57014']);
  });

  it('a data error in date 2\'s validation read fails that date only; dates 1 and 3 are written', async () => {
    arm('SELECT id FROM practice_clients', 'div0');
    let r; let fired = 0;
    try { r = await fill(); fired = fault.seen; } finally { disarm(); }
    expect(fired).toBe(3);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toEqual({
      created: 2, skipped: 0, failed: [{ date: '2026-01-06', error: 'Could not create this entry' }],
    });
    const dates = (await f.pool.query(
      "SELECT to_char(entry_date, 'YYYY-MM-DD') AS d FROM time_entries WHERE company_id = $1 AND task_description = 'EBQ bulk' ORDER BY 1",
      [f.A])).rows.map((x: { d: string }) => x.d);
    expect(dates).toEqual(['2026-01-05', '2026-01-07']);
  });
});
