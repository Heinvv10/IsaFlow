// tests/integration/practice-engagement-budget-routes.int.test.ts
//
// Engagement Budgets: every path that writes a time entry's job answers a
// fence refusal with a 400 and its message, writes nothing, and a bad body is
// a 400, not a 500. Covers the time-entries POST / [id] PUT / duplicate / GET,
// the bulk fill-from-template route and the MCP log_time_entry tool (whose
// PRACTICE_JOB_NOT_FOUND / PRACTICE_JOB_CLOSED messages reach the agent).
// Fixture: practice-engagement-budget.helpers.ts (isaflow_dev, own companies).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import timeEntriesRoute from '../../pages/api/accounting/practice/time-entries';
import entryRoute from '../../pages/api/accounting/practice/time-entries/[id]';
import duplicateRoute from '../../pages/api/accounting/practice/time-entries/duplicate';
import bulkRoute from '../../pages/api/accounting/practice/time-entries/bulk';
import { logTimeEntryTool } from '@/lib/mcp/tools/writePracticeTime';
import type { McpToolContext } from '@/lib/mcp/types';
import { createEbFixture, ebDbAvailable, type EbFixture } from './practice-engagement-budget.helpers';

const describeIfDb = ebDbAvailable ? describe : describe.skip;

describeIfDb('Engagement budgets — routes, bulk and MCP refuse a foreign or closed job', () => {
  let f: EbFixture;
  const J: Record<string, string> = {};
  const base = () => ({ entryDate: '2026-01-12', hours: 1, practiceClientId: f.CLIENT, jobCategoryId: f.CAT, workItemId: f.ITEM });
  const row = async (id: string) =>
    (await f.pool.query('SELECT job_id, practice_client_id, hours, updated_at FROM time_entries WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    f = await createEbFixture('EBR');
    J.own = await f.job(f.A, f.CLIENT, 'EBR own');
    J.client2 = await f.job(f.A, f.CLIENT2, 'EBR client 2');
    J.b = await f.job(f.B, f.CLIENT_B, 'EBR B job');
    J.done = await f.job(f.A, f.CLIENT, 'EBR complete', { status: 'complete' });
  });

  afterAll(async () => { if (f) await f.cleanup(); });

  describe('POST /time-entries', () => {
    it('answers a foreign job with 400 and its message, storing nothing; its own job with 201', async () => {
      const refused = await f.call(timeEntriesRoute, 'POST', { ...base(), taskDescription: 'EBR refused', jobId: J.b });
      expect(refused.statusCode).toBe(400);
      expect(refused.body.error?.message).toMatch(/was not found for this client/);
      expect(await f.entriesNamed('EBR refused')).toBe(0);
      const ok = await f.call(timeEntriesRoute, 'POST', { ...base(), taskDescription: 'EBR ok', jobId: J.own });
      expect(ok.statusCode, JSON.stringify(ok.body)).toBe(201);
      expect(await f.entriesNamed('EBR ok')).toBe(1);
    });

    it('answers a closed job with 400 and its message', async () => {
      const r = await f.call(timeEntriesRoute, 'POST', { ...base(), taskDescription: 'EBR closed', jobId: J.done });
      expect(r.statusCode).toBe(400);
      expect(r.body.error?.message).toMatch(/is complete/);
      expect(await f.entriesNamed('EBR closed')).toBe(0);
    });

    it.each([['null', null], ['an array', [1]], ['a string', 'x']])('answers a body that is %s with 400 naming the body', async (_l, body) => {
      const r = await f.call(timeEntriesRoute, 'POST', body);
      expect(r.statusCode).toBe(400);
      expect(r.body.error?.message).toBe('Request body must be a JSON object');
    });
  });

  it('GET /time-entries answers a malformed jobId with 400, a real one with 200', async () => {
    expect((await f.call(timeEntriesRoute, 'GET', {}, { jobId: 'nope' })).statusCode).toBe(400);
    expect((await f.call(timeEntriesRoute, 'GET', {}, { jobId: J.own! })).statusCode).toBe(200);
  });

  describe('PUT /time-entries/[id]', () => {
    let id = '';
    beforeAll(async () => { id = await f.entry({ job: J.own!, hours: 1, rate: 1000, desc: 'EBR put' }); });
    const put = (body: unknown) => f.call(entryRoute, 'PUT', body, { id });

    it.each([
      ['the client only, keeping the job', () => ({ practiceClientId: f.CLIENT2 })],
      ['a foreign company\'s job', () => ({ jobId: J.b })],
      ['another client\'s job', () => ({ jobId: J.client2 })],
      ['a closed job', () => ({ jobId: J.done })],
      ['a number', () => ({ jobId: 5 })],
      ['an array', () => ({ jobId: [J.own] })],
      ['an object', () => ({ jobId: { id: J.own } })],
      ['true', () => ({ jobId: true })],
      ['a malformed uuid plus an hours change', () => ({ jobId: 'zz', hours: 7 })],
      ['a mismatched client/job pair', () => ({ practiceClientId: f.CLIENT2, jobId: J.own })],
    ])('refuses %s with 400 and changes nothing', async (_l, body) => {
      const before = await row(id);
      const r = await put(body());
      expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
      expect(await row(id)).toEqual(before);
    });

    it('answers a non-object body with 400 naming the body', async () => {
      for (const body of [null, 'x']) expect((await put(body)).body.error?.message).toBe('Request body must be a JSON object');
    });

    it('accepts a matching client/job pair', async () => {
      const r = await put({ practiceClientId: f.CLIENT2, jobId: J.client2 });
      expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
      expect(await f.jobOf(id)).toBe(J.client2);
    });
  });

  it('POST /duplicate answers a source on a now-closed job with 400 and its message', async () => {
    const jobId = await f.job(f.A, f.CLIENT, 'EBR closes');
    const id = await f.entry({ job: jobId, hours: 1, rate: 1000, desc: 'EBR dup src' });
    await f.pool.query("UPDATE practice_jobs SET status = 'billed' WHERE id = $1", [jobId]);
    const r = await f.call(duplicateRoute, 'POST', { id, newDate: '2026-01-20' });
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toMatch(/is billed/);
    expect(await f.entriesNamed('EBR dup src')).toBe(1);
  });

  describe('POST /time-entries/bulk', () => {
    let templateId = '';
    beforeAll(async () => {
      templateId = randomUUID();
      await f.pool.query(
        `INSERT INTO practice_entry_templates (id, company_id, user_id, name, practice_client_id, job_category_id,
           work_item_id, default_hours, task_description, billable)
         VALUES ($1, $2, $3, 'EBR tpl', $4, $5, $6, 2, 'EBR bulk', true)`,
        [templateId, f.A, f.USER, f.CLIENT, f.CAT, f.ITEM]);
    });
    const bulk = (jobId: unknown) => f.call(bulkRoute, 'POST',
      { templateId, dateFrom: '2026-01-05', dateTo: '2026-01-07', weekdays: [1, 2, 3], jobId });
    const onJob = async (job: string) => Number((await f.pool.query(
      "SELECT count(*) AS n FROM time_entries WHERE company_id = $1 AND task_description = 'EBR bulk' AND job_id = $2",
      [f.A, job])).rows[0].n);

    it.each([['a foreign job', () => J.b], ['another client\'s job', () => J.client2], ['a closed job', () => J.done]])(
      'refuses %s with 400 and creates nothing', async (_l, job) => {
        const r = await bulk(job());
        expect(r.statusCode).toBe(400);
        expect(r.body.error?.message).toMatch(/not found for this client|is complete/);
        expect(await f.entriesNamed('EBR bulk')).toBe(0);
      });

    it('fills the range against the chosen job', async () => {
      const r = await bulk(J.own);
      expect(r.statusCode, JSON.stringify(r.body)).toBe(201);
      expect(await onJob(J.own!)).toBe(3);
    });
  });

  describe('MCP log_time_entry job_id', () => {
    const today = new Date().toISOString().slice(0, 10);
    const ctx = (): McpToolContext => ({
      userId: f.USER, companyId: f.A, scopes: ['write:practice'], tokenJti: 'eb', oauthAppId: null, companyRole: 'admin',
    });
    const log = (extra: Record<string, unknown>) => f.inTx(() => logTimeEntryTool.handler({
      entry_date: today, hours: 1, practice_client_id: f.CLIENT, job_category_id: f.CAT, work_item_id: f.ITEM,
      task_description: 'EBR mcp', idempotency_key: randomUUID(), ...extra,
    }, ctx()));

    it('books the entry against an open job of the client', async () => {
      const r = await log({ job_id: J.own });
      expect(r.isError, r.content[0]?.text).toBeFalsy();
      const id = String(JSON.parse(r.content[0]!.text).id);
      expect(await f.jobOf(id)).toBe(J.own);
    });

    it.each([
      ['a foreign job (PRACTICE_JOB_NOT_FOUND)', () => J.b, /was not found for this client/],
      ['a closed job (PRACTICE_JOB_CLOSED)', () => J.done, /is complete/],
    ])('surfaces the refusal for %s to the agent, live and in dry_run', async (_l, job, msg) => {
      const before = await f.entriesNamed('EBR mcp');
      for (const dry of [false, true]) {
        const r = await log({ job_id: job(), dry_run: dry });
        expect(r.isError).toBe(true);
        expect(r.content[0]?.text).toMatch(msg);
      }
      expect(await f.entriesNamed('EBR mcp')).toBe(before);
    });

    it('refuses a non-string job_id', async () => {
      const r = await log({ job_id: 7 });
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/job_id must be a string/);
    });
  });
});
