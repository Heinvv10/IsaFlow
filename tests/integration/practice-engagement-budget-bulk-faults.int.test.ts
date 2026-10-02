// tests/integration/practice-engagement-budget-bulk-faults.int.test.ts
//
// Bulk fill-from-template under REAL Postgres errors on date 2 of 3. On valid
// input no database error is reachable on this INSERT, so every one is a
// fault: a statement timeout (57014), a data error (22012), schema drift (a
// NOT NULL column a deploy added, 23502) or a code bug (22P02). The service
// re-throws it, the route re-throws it (a 4xx would make withAuth COMMIT date
// 1), withErrorHandler answers 500, nothing of the range is written, and the
// route logs the cause at error. A per-date refusal is the only partial
// result (practice-engagement-budget-routes.int.test.ts).
// The fault runs a real failing statement through the original `sql` inside
// the caller's transaction — not a synthetic throw. (Breaker round 3/4.)
// Fixture: practice-engagement-budget.helpers.ts (isaflow_dev, own companies).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';

type Step = 'ok' | '57014' | '22012' | '23502' | '22P02';
const fault = vi.hoisted(() => ({ plan: [] as string[], seen: 0 }));
vi.mock('@/lib/neon', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/neon')>();
  const call = orig.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
  const wrapped = (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    if (strings.join('?').includes('INSERT INTO time_entries') && fault.plan.length) {
      fault.seen++;
      const step = fault.plan.shift();
      if (step === '57014') { await orig.sql`SET LOCAL statement_timeout = '50ms'`; await orig.sql`SELECT pg_sleep(1)`; }
      if (step === '22012') await orig.sql`SELECT 1 / 0`;
      if (step === '22P02') await orig.sql`SELECT 'null'::uuid`;
      if (step === '23502') {
        await orig.sql`CREATE TEMP TABLE IF NOT EXISTS ebq_drift (a int NOT NULL) ON COMMIT DROP`;
        await orig.sql`INSERT INTO ebq_drift VALUES (NULL)`;
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
  afterAll(async () => { fault.plan = []; if (f) await f.cleanup(); });

  it.each<[string, Step]>([
    ['a statement timeout', '57014'],
    ['a data error', '22012'],
    ['schema drift: a NOT NULL column a deploy added', '23502'],
    ['a code bug: bad input syntax', '22P02'],
  ])('%s (%s) on date 2 of 3 answers 500, writes nothing, and logs the cause', async (_l, code) => {
    const errSpy = vi.spyOn(log, 'error');
    Object.assign(fault, { plan: ['ok', code], seen: 0 });
    let r; let seen = 0;
    try { r = await fill(); seen = fault.seen; } finally { fault.plan = []; }
    const causes = errSpy.mock.calls.filter((c) => c[0] === 'Practice bulk create from template failed')
      .map((c) => (c[1] as { error?: { code?: string } }).error?.code);
    errSpy.mockRestore();
    expect(seen).toBe(2); // date 1 inserted, date 2 faulted, date 3 never reached
    expect(r!.statusCode, JSON.stringify(r!.body)).toBe(500);
    expect(await f.entriesNamed('EBQ bulk')).toBe(0);
    expect(causes).toEqual([code]);
  });
});
