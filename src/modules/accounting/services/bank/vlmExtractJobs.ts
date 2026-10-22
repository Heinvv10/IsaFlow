/**
 * Scan & Fill jobs — the process-local store behind `vlm-extract`.
 *
 * Scan & Fill reads a file and persists nothing, so a read that runs after the
 * request (a long digital PDF outlasts Cloudflare's 100 s) has no row to leave
 * its result on. The result waits here for the client's poll instead: a Map on
 * globalThis (Next may load this module more than once), keyed by a random
 * job id, holding who asked and the outcome.
 *
 * A job is visible only to the company AND the user that started it; anyone
 * else, and any unknown id, gets null (a 404), so ids reveal nothing.
 * Production runs one Next process, so a restart loses in-flight jobs: the poll
 * gets a 404 and the client says the scan was interrupted.
 *
 * Bounds: an entry is forgotten JOB_TTL_MS after it was registered (a running
 * entry is never evicted before that); at most MAX_UNFINISHED_PER_COMPANY /
 * MAX_UNFINISHED_TOTAL jobs are unfinished at once, so a burst cannot pile reads
 * onto the shared VLM; at most MAX_ENTRIES are held, oldest finished first.
 * A job is registered BEFORE the request commits, as 'queued'. One that has not
 * started QUEUED_START_MS later (the request rolled back, or the after-commit
 * start never came) reads as failed and counts against no cap.
 */

import { randomUUID } from 'crypto';
import { log } from '@/lib/logger';
import type { ExtractedDocument } from '../../types/documentCapture.types';

export const VLM_JOBS_KEY = '__isaflowVlmExtractJobs';
export const JOB_TTL_MS = 15 * 60_000;
export const QUEUED_START_MS = 60_000;
export const MAX_UNFINISHED_PER_COMPANY = 3;
export const MAX_UNFINISHED_TOTAL = 20;
const MAX_ENTRIES = 200;

export const SCAN_FAILED = 'The scan failed — try again.';
export const SCAN_NOT_STARTED = 'The scan did not start — try again.';

type JobState = 'queued' | 'running' | 'done' | 'failed';

interface Job {
  companyId: string;
  userId: string;
  state: JobState;
  createdAt: number;
  extracted?: ExtractedDocument;
  error?: string;
}

export type VlmJobView =
  | { state: 'reading' }
  | { state: 'done'; extracted: ExtractedDocument }
  | { state: 'failed'; error: string };

export type RegisterResult = { jobId: string } | { refused: 'company' | 'platform' };

function jobs(): Map<string, Job> {
  const g = globalThis as Record<string, unknown>;
  if (!g[VLM_JOBS_KEY]) g[VLM_JOBS_KEY] = new Map<string, Job>();
  return g[VLM_JOBS_KEY] as Map<string, Job>;
}

const queuedTooLong = (job: Job, now: number) => job.state === 'queued' && now - job.createdAt > QUEUED_START_MS;
const isUnfinished = (job: Job, now: number) => job.state === 'running' || (job.state === 'queued' && !queuedTooLong(job, now));

function prune(store: Map<string, Job>, now: number): void {
  for (const [id, job] of store) {
    if (now - job.createdAt > JOB_TTL_MS) store.delete(id);
  }
  // Map iterates in insertion order, so the first finished entry is the oldest.
  for (const [id, job] of store) {
    if (store.size < MAX_ENTRIES) break;
    if (!isUnfinished(job, now)) store.delete(id);
  }
}

/** Register a job for `companyId`/`userId` as 'queued', or say which cap refused it. */
export function registerVlmExtractJob(companyId: string, userId: string, now: number = Date.now()): RegisterResult {
  const store = jobs();
  prune(store, now);
  let forCompany = 0;
  let total = 0;
  for (const job of store.values()) {
    if (!isUnfinished(job, now)) continue;
    total += 1;
    if (job.companyId === companyId) forCompany += 1;
  }
  if (forCompany >= MAX_UNFINISHED_PER_COMPANY) return { refused: 'company' };
  if (total >= MAX_UNFINISHED_TOTAL) return { refused: 'platform' };
  const jobId = randomUUID();
  store.set(jobId, { companyId, userId, state: 'queued', createdAt: now });
  return { jobId };
}

/**
 * Run `read` for a registered job and keep its outcome. Started after COMMIT.
 * Never throws: a failure is logged and the job ends 'failed' with a generic
 * message. A job that is gone, or waited out its start window, is not run.
 */
export async function runVlmExtractJob(
  jobId: string, read: () => Promise<ExtractedDocument>, now: number = Date.now(),
): Promise<void> {
  const store = jobs();
  const job = store.get(jobId);
  if (!job || job.state !== 'queued' || queuedTooLong(job, now)) {
    log.warn('vlmExtract: job is gone or did not start in time, not run', { jobId }, 'vlm-extract');
    return;
  }
  job.state = 'running';
  try {
    const extracted = await read();
    if (store.get(jobId) !== job) {
      log.warn('vlmExtract: job expired while it was read, result dropped', { jobId }, 'vlm-extract');
      return;
    }
    job.extracted = extracted;
    job.state = 'done';
  } catch (err) {
    log.error('vlmExtract: read failed', { jobId, error: err instanceof Error ? err.message : String(err) }, 'vlm-extract');
    job.error = SCAN_FAILED;
    job.state = 'failed';
  }
}

/** The job as its owner sees it; null for an unknown, expired or someone else's id. */
export function getVlmExtractJob(
  jobId: string, companyId: string, userId: string, now: number = Date.now(),
): VlmJobView | null {
  const store = jobs();
  prune(store, now);
  const job = store.get(jobId);
  if (!job || job.companyId !== companyId || job.userId !== userId) return null;
  if (queuedTooLong(job, now)) return { state: 'failed', error: SCAN_NOT_STARTED };
  if (job.state === 'done' && job.extracted) return { state: 'done', extracted: job.extracted };
  if (job.state === 'failed') return { state: 'failed', error: job.error ?? SCAN_FAILED };
  return { state: 'reading' };
}
