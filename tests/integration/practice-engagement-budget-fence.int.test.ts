// tests/integration/practice-engagement-budget-fence.int.test.ts
//
// The jobId on a time entry (Engagement Budgets). It was accepted and never
// written; create, update and duplicate now write it behind
// assertJobForPracticeClient: the job must be this company's AND the entry's
// own client's, and a NEW link to a closed job (complete/cancelled/billed) is
// refused — an entry that keeps the job it has is not. Service-level; the
// route answers are in practice-engagement-budget-routes.int.test.ts.
// Fixture: practice-engagement-budget.helpers.ts (isaflow_dev, own companies).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPracticeEntry,
  updatePracticeEntry,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { duplicatePracticeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';
import { listJobBudgetStatuses } from '@/modules/accounting/services/practice/practiceJobBudgetService';
import {
  PracticeJobClosedError,
  PracticeJobNotForClientError,
} from '@/modules/accounting/services/practice/practiceClientFence';
import { createEbFixture, ebDbAvailable, type EbFixture } from './practice-engagement-budget.helpers';

const describeIfDb = ebDbAvailable ? describe : describe.skip;

describeIfDb('Engagement budgets — the jobId fence on time entries', () => {
  let f: EbFixture;
  const J: Record<string, string> = {};
  const base = () => ({ entryDate: '2026-01-12', hours: 1, practiceClientId: f.CLIENT, jobCategoryId: f.CAT, workItemId: f.ITEM });
  const create = (desc: string, extra: Record<string, unknown> = {}) =>
    f.inTx(() => createPracticeEntry(f.A, f.USER, { ...base(), taskDescription: desc, ...extra }));

  beforeAll(async () => {
    f = await createEbFixture('EBF');
    J.own = await f.job(f.A, f.CLIENT, 'EBF own');
    J.own2 = await f.job(f.A, f.CLIENT, 'EBF own 2');
    J.client2 = await f.job(f.A, f.CLIENT2, 'EBF client 2');
    J.b = await f.job(f.B, f.CLIENT_B, 'EBF B job');
    J.bOnA = await f.job(f.B, f.CLIENT, 'EBF B job on A client');
    for (const st of ['complete', 'cancelled', 'billed']) J[st] = await f.job(f.A, f.CLIENT, `EBF ${st}`, { status: st });
    J.closing = await f.job(f.A, f.CLIENT, 'EBF closes later');
  });

  afterAll(async () => { if (f) await f.cleanup(); });

  describe('create', () => {
    it('writes the job when it is this client\'s', async () => {
      const e = await create('EBF own job', { jobId: J.own });
      expect(e.jobId).toBe(J.own);
      expect(await f.jobOf(e.id)).toBe(J.own);
    });

    it.each([['\'\'', ''], ['null', null], ['undefined', undefined]])('treats %s as no job', async (_l, jobId) => {
      const e = await create(`EBF no job ${String(jobId)}`, { jobId });
      expect(await f.jobOf(e.id)).toBeNull();
    });

    it.each([
      ['company B\'s job', () => J.b],
      ['company B\'s job on this client', () => J.bOnA],
      ['a job on another of this company\'s clients', () => J.client2],
      ['a malformed id', () => 'not-a-uuid'],
      ['a number', () => 5],
    ])('refuses %s with PracticeJobNotForClientError and writes nothing', async (label, jobId) => {
      const desc = `EBF refused ${label}`;
      await expect(create(desc, { jobId: jobId() })).rejects.toBeInstanceOf(PracticeJobNotForClientError);
      expect(await f.entriesNamed(desc)).toBe(0);
    });

    it.each(['complete', 'cancelled', 'billed'])('refuses a %s job with PracticeJobClosedError', async (st) => {
      const desc = `EBF closed ${st}`;
      await expect(create(desc, { jobId: J[st] })).rejects.toBeInstanceOf(PracticeJobClosedError);
      expect(await f.entriesNamed(desc)).toBe(0);
    });

    it('a refused malformed id leaves the transaction usable (the read is savepointed)', async () => {
      const rows = await f.inTx(async () => {
        await createPracticeEntry(f.A, f.USER, { ...base(), taskDescription: 'EBF malformed', jobId: 'nope' })
          .catch((err: unknown) => { if (!(err instanceof PracticeJobNotForClientError)) throw err; });
        return listJobBudgetStatuses(f.A, { jobId: J.own! });
      });
      expect(rows).toHaveLength(1);
    });
  });

  describe('update', () => {
    let id = '';
    beforeAll(async () => { id = (await create('EBF update')).id; });

    it('sets the job, keeps it when jobId is absent or undefined, and clears it on \'\'', async () => {
      expect((await f.inTx(() => updatePracticeEntry(f.A, id, { jobId: J.own }))).jobId).toBe(J.own);
      expect((await f.inTx(() => updatePracticeEntry(f.A, id, { hours: 2 }))).jobId).toBe(J.own);
      expect((await f.inTx(() => updatePracticeEntry(f.A, id, { hours: 2.5, jobId: undefined }))).jobId).toBe(J.own);
      expect((await f.inTx(() => updatePracticeEntry(f.A, id, { jobId: '' }))).jobId).toBeNull();
      expect((await f.inTx(() => updatePracticeEntry(f.A, id, { jobId: J.own }))).jobId).toBe(J.own);
    });

    it('refuses a foreign job and keeps the old one', async () => {
      await expect(f.inTx(() => updatePracticeEntry(f.A, id, { jobId: J.b })))
        .rejects.toBeInstanceOf(PracticeJobNotForClientError);
      expect(await f.jobOf(id)).toBe(J.own);
    });

    it('moving the entry to another client while it names this client\'s job is refused; a matching pair is not', async () => {
      await expect(f.inTx(() => updatePracticeEntry(f.A, id, { practiceClientId: f.CLIENT2 })))
        .rejects.toBeInstanceOf(PracticeJobNotForClientError);
      expect((await f.inTx(() => updatePracticeEntry(f.A, id, { practiceClientId: f.CLIENT2, jobId: J.client2 }))).jobId)
        .toBe(J.client2);
      expect((await f.inTx(() => updatePracticeEntry(f.A, id, { practiceClientId: f.CLIENT, jobId: J.own }))).jobId)
        .toBe(J.own);
    });

    it('changing to a closed job is refused; keeping a job that has since closed is not', async () => {
      await expect(f.inTx(() => updatePracticeEntry(f.A, id, { jobId: J.complete })))
        .rejects.toBeInstanceOf(PracticeJobClosedError);
      const e = await create('EBF keeps closing job', { jobId: J.closing });
      await f.pool.query("UPDATE practice_jobs SET status = 'complete' WHERE id = $1", [J.closing]);
      expect((await f.inTx(() => updatePracticeEntry(f.A, e.id, { hours: 3 }))).jobId).toBe(J.closing);
      expect((await f.inTx(() => updatePracticeEntry(f.A, e.id, { hours: 3.5, jobId: J.closing }))).jobId).toBe(J.closing);
    });
  });

  describe('duplicate', () => {
    it('carries the job', async () => {
      const e = await create('EBF dup', { jobId: J.own2 });
      const d = await f.inTx(() => duplicatePracticeEntry(f.A, e.id, '2026-01-13', f.USER));
      expect(await f.jobOf(d.id)).toBe(J.own2);
    });

    it.each([
      ['another client\'s job', () => ({ client: f.CLIENT, job: J.client2! })],
      ['another company\'s job', () => ({ client: f.CLIENT, job: J.b! })],
    ])('refuses a legacy source entry that names %s', async (label, src) => {
      const desc = `EBF legacy ${label}`;
      const id = await f.plantLegacy({ company: f.A, cat: f.CAT, item: f.ITEM, hours: 1, rate: 1000, desc, ...src() });
      await expect(f.inTx(() => duplicatePracticeEntry(f.A, id, '2026-01-14', f.USER)))
        .rejects.toBeInstanceOf(PracticeJobNotForClientError);
      expect(await f.entriesNamed(desc)).toBe(1);
    });

    it('refuses copying an entry onto a job that has closed (a new link)', async () => {
      const e = await create('EBF dup closed', { jobId: J.own2 });
      await f.pool.query("UPDATE practice_jobs SET status = 'cancelled' WHERE id = $1", [J.own2]);
      await expect(f.inTx(() => duplicatePracticeEntry(f.A, e.id, '2026-01-15')))
        .rejects.toBeInstanceOf(PracticeJobClosedError);
      expect(await f.entriesNamed('EBF dup closed')).toBe(1);
    });
  });
});
