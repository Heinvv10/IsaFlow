/**
 * The rubric harness's evidence (master plan wave 4, MW): tests/e2e/rubric/_rubricEvidence.ts. A step that outlives its
 * limit is stopped (its pages closed) before the next one starts, and a run whose every step was skipped fails.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { Evidence, Tally, skippedRerun } from '../../e2e/rubric/_rubricEvidence';

/** A page that a step's pending action waits on: closing it rejects that action, as Playwright does. */
function fakePage() {
  let closed = false;
  const waiters: Array<(e: Error) => void> = [];
  const page = {
    isClosed: () => closed,
    close: async () => { closed = true; waiters.splice(0).forEach((w) => w(new Error('Target page has been closed'))); },
    screenshot: async () => Buffer.from(''),
  };
  const pendingAction = () => new Promise<never>((_, reject) => { waiters.push(reject); });
  return { page: page as unknown as Page, pendingAction, closed: () => closed };
}

const evidence = (limits = { stepMs: 30, settleMs: 200 }) =>
  new Evidence(mkdtempSync(join(tmpdir(), 'rubric-ev-')), { runId: 't' }, limits);

describe('a step over its limit', () => {
  it('is recorded failed, and its pages are closed so it stops before step() returns', async () => {
    const ev = evidence();
    const f = fakePage();
    let settled = false;
    const record = await ev.step('slow', async () => {
      try { return await f.pendingAction(); } finally { settled = true; }
    }, () => [f.page]);
    expect(record.status).toBe('failed');
    expect((record as { error: string }).error).toMatch(/took over/);
    expect(f.closed()).toBe(true);
    expect(settled).toBe(true);
  });

  it('aborts the run when the step still has not stopped after its pages closed', async () => {
    const ev = evidence();
    const f = fakePage();
    await expect(ev.step('stuck', () => new Promise<never>(() => undefined), () => [f.page])).rejects.toThrow(/did not stop/);
    expect(ev.failures().join()).toMatch(/stuck: .*did not stop/);
  });

  it('leaves the pages of a step that finished in time open', async () => {
    const ev = evidence();
    const f = fakePage();
    expect((await ev.step('fast', async () => ({ status: 'measured' }), () => [f.page])).status).toBe('measured');
    expect(f.closed()).toBe(false);
  });
});

describe('a tally', () => {
  it('keeps work run off its clock out of its time', async () => {
    const tally = new Tally(fakePage().page);
    await tally.offClock(() => new Promise((resolve) => setTimeout(resolve, 120)));
    expect(tally.summary().ms).toBeLessThan(60);
  });
});

describe('skipped steps', () => {
  it('say "skipped (re-run)" in the record and the summary', async () => {
    const ev = evidence();
    await ev.step('M5', async () => skippedRerun('the run is approved'));
    await ev.step('M4', async () => ({ status: 'measured' }));
    const file = JSON.parse(readFileSync(ev.file, 'utf8')) as { steps: Record<string, { reason: string }>; summary: Record<string, string[]> };
    expect(file.steps.M5!.reason).toBe('skipped (re-run): the run is approved');
    expect(file.summary).toEqual({ measured: ['M4'], 'not built': [], 'skipped (re-run)': ['M5'], failed: [] });
    expect(ev.failures()).toEqual([]);
  });

  it('fail the run when every step was skipped', async () => {
    const ev = evidence();
    await ev.step('M5', async () => skippedRerun('approved'));
    await ev.step('T4', async () => skippedRerun('approved'));
    expect(ev.failures()).toEqual(['every step was skipped (a re-run of a finished run id measures nothing)']);
  });
});
