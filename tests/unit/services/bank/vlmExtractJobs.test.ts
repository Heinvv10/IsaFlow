/**
 * The process-local store behind Scan & Fill. The read runs after the request, so the result waits here for the
 * client's poll. Entries are scoped to company AND user, expire, and are capped so a burst cannot grow the heap or
 * pile reads onto the shared VLM.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  getVlmExtractJob, registerVlmExtractJob, runVlmExtractJob, VLM_JOBS_KEY,
  JOB_TTL_MS, QUEUED_START_MS, MAX_UNFINISHED_PER_COMPANY, MAX_UNFINISHED_TOTAL, SCAN_FAILED, SCAN_NOT_STARTED,
} from '@/modules/accounting/services/bank/vlmExtractJobs';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const CO2 = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER = 'user-1';
const USER2 = 'user-2';
const T0 = Date.parse('2026-10-22T10:00:00.000Z');
const doc = { vendorName: 'Acme', totalAmount: 115 } as unknown as ExtractedDocument;

function register(company = CO, user = USER, now = T0): string {
  const r = registerVlmExtractJob(company, user, now);
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  return r.jobId;
}

beforeEach(() => { delete (globalThis as Record<string, unknown>)[VLM_JOBS_KEY]; });

describe('registerVlmExtractJob', () => {
  it('hands out a UUID and the job reads as reading before it starts', () => {
    const id = register();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getVlmExtractJob(id, CO, USER, T0 + 1000)).toEqual({ state: 'reading' });
  });

  it('refuses a 4th unfinished job for a company, and counts only that company', () => {
    for (let i = 0; i < MAX_UNFINISHED_PER_COMPANY; i++) register();
    expect(MAX_UNFINISHED_PER_COMPANY).toBe(3);
    expect(registerVlmExtractJob(CO, USER, T0)).toEqual({ refused: 'company' });
    expect('jobId' in registerVlmExtractJob(CO2, USER, T0)).toBe(true);
  });

  it('refuses a job past the platform-wide cap of unfinished jobs', () => {
    expect(MAX_UNFINISHED_TOTAL).toBe(20);
    for (let i = 0; i < MAX_UNFINISHED_TOTAL; i++) register(`co-${i}`);
    expect(registerVlmExtractJob('co-new', USER, T0)).toEqual({ refused: 'platform' });
  });

  it('does not count a finished job against the caps', async () => {
    for (let i = 0; i < 3; i++) await runVlmExtractJob(register(), async () => doc, T0);
    expect('jobId' in registerVlmExtractJob(CO, USER, T0)).toBe(true);
  });

  it('does not count a queued job that never started against the caps', () => {
    for (let i = 0; i < 3; i++) register();
    expect('jobId' in registerVlmExtractJob(CO, USER, T0 + QUEUED_START_MS + 1)).toBe(true);
  });

  it('forgets an entry after its TTL, so the store does not grow', async () => {
    const id = register();
    await runVlmExtractJob(id, async () => doc, T0);
    expect(getVlmExtractJob(id, CO, USER, T0 + JOB_TTL_MS - 1)).toMatchObject({ state: 'done' });
    expect(JOB_TTL_MS).toBe(15 * 60_000);
    registerVlmExtractJob(CO2, USER, T0 + JOB_TTL_MS + 1);
    const store = (globalThis as Record<string, Map<string, unknown>>)[VLM_JOBS_KEY]!;
    expect(store.has(id)).toBe(false);
    expect(getVlmExtractJob(id, CO, USER, T0 + JOB_TTL_MS + 1)).toBeNull();
  });
});

describe('runVlmExtractJob', () => {
  it('stores the extraction and the job reads as done with it', async () => {
    const id = register();
    await runVlmExtractJob(id, async () => doc, T0);
    expect(getVlmExtractJob(id, CO, USER, T0)).toEqual({ state: 'done', extracted: doc });
  });

  it('shows a job whose read is still running as reading', async () => {
    const id = register();
    let release: () => void = () => undefined;
    const running = runVlmExtractJob(id, () => new Promise<ExtractedDocument>((resolve) => { release = () => resolve(doc); }), T0);
    expect(getVlmExtractJob(id, CO, USER, T0 + 120_000)).toEqual({ state: 'reading' });
    release();
    await running;
    expect(getVlmExtractJob(id, CO, USER, T0 + 120_000)).toMatchObject({ state: 'done' });
  });

  it('records a throw as failed with a generic message, never the real error, and does not throw', async () => {
    const id = register();
    await expect(runVlmExtractJob(id, async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8100'); }, T0)).resolves.toBeUndefined();
    const job = getVlmExtractJob(id, CO, USER, T0);
    expect(job).toEqual({ state: 'failed', error: SCAN_FAILED });
    expect(JSON.stringify(job)).not.toContain('ECONNREFUSED');
  });

  it('does not run a job whose entry has gone, or one that waited out the 60 s start window', async () => {
    const read = vi.fn(async () => doc);
    await runVlmExtractJob('00000000-0000-4000-8000-000000000000', read, T0);
    const late = register();
    await runVlmExtractJob(late, read, T0 + QUEUED_START_MS + 1);
    expect(read).not.toHaveBeenCalled();
  });

  it('drops a result that finishes after its entry expired', async () => {
    const id = register();
    await runVlmExtractJob(id, async () => {
      registerVlmExtractJob(CO2, USER, T0 + JOB_TTL_MS + 5);
      return doc;
    }, T0);
    expect(getVlmExtractJob(id, CO, USER, T0 + JOB_TTL_MS + 5)).toBeNull();
  });
});

describe('getVlmExtractJob', () => {
  it('reports a queued job not started within 60 s as failed: the scan did not start', () => {
    const id = register();
    expect(getVlmExtractJob(id, CO, USER, T0 + QUEUED_START_MS)).toEqual({ state: 'reading' });
    expect(getVlmExtractJob(id, CO, USER, T0 + QUEUED_START_MS + 1)).toEqual({ state: 'failed', error: SCAN_NOT_STARTED });
    expect(SCAN_NOT_STARTED).toBe('The scan did not start — try again.');
  });

  it("is null for another company's job, even for the same user id", () => {
    const id = register();
    expect(getVlmExtractJob(id, CO2, USER, T0)).toBeNull();
  });

  it("is null for another user's job in the same company", () => {
    const id = register();
    expect(getVlmExtractJob(id, CO, USER2, T0)).toBeNull();
  });

  it('is null for an unknown id', () => {
    expect(getVlmExtractJob('00000000-0000-4000-8000-000000000000', CO, USER, T0)).toBeNull();
  });

  it('keeps the store on globalThis, so a second module instance sees the same jobs', () => {
    const id = register();
    expect((globalThis as Record<string, Map<string, unknown>>)[VLM_JOBS_KEY]!.has(id)).toBe(true);
  });
});
