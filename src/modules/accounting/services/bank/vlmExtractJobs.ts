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
 * Bounds: a RUNNING job is never pruned while it runs (its result must have
 * somewhere to land) and counts against the caps, until JOB_RUN_CEILING_MS after
 * it started: past that it is failed (SCAN_TOO_LONG), stops counting, and a late
 * settle is ignored, so a read that never settles cannot hold a slot for ever. A FINISHED entry is forgotten
 * JOB_TTL_MS after it finished. At most MAX_UNFINISHED_PER_COMPANY /
 * MAX_UNFINISHED_TOTAL jobs are unfinished at once, so a burst cannot pile reads
 * onto the shared VLM; at most MAX_ENTRIES are held, oldest finished first.
 * A job is registered BEFORE the request commits, as 'queued'. One that has not
 * started QUEUED_START_MS later (the request rolled back, or the after-commit
 * start never came) reads as failed, counts against no cap, and is forgotten
 * JOB_TTL_MS after it was registered.
 */

import { randomUUID } from 'crypto';
import { log } from '@/lib/logger';
import type { ExtractedDocument } from '../../types/documentCapture.types';

export const VLM_JOBS_KEY = '__isaflowVlmExtractJobs';
export const JOB_TTL_MS = 15 * 60_000;
export const QUEUED_START_MS = 60_000;
/** A scan still running this long after it started is given up on: failed, no longer counted, a late settle ignored. */
export const JOB_RUN_CEILING_MS = 30 * 60_000;
export const MAX_UNFINISHED_PER_COMPANY = 3;
export const MAX_UNFINISHED_TOTAL = 20;
const MAX_ENTRIES = 200;

export const SCAN_FAILED = 'The scan failed — try again.';
export const SCAN_NOT_STARTED = 'The scan did not start — try again.';
export const SCAN_TOO_LONG = 'The scan took too long — try again.';

type JobState = 'queued' | 'running' | 'done' | 'failed';

interface Job {
  companyId: string;
  userId: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  extracted?: ExtractedDocument;
  error?: string;
}

export type VlmJobView =
  | { state: 'reading' }
  | { state: 'done'; extracted: ExtractedDocument }
  | { state: 'failed'; error: string };

export type CapacityRefusal = { refused: 'company' | 'platform' };
export type RegisterResult = { jobId: string } | CapacityRefusal;

function jobs(): Map<string, Job> {
  const g = globalThis as Record<string, unknown>;
  if (!g[VLM_JOBS_KEY]) g[VLM_JOBS_KEY] = new Map<string, Job>();
  return g[VLM_JOBS_KEY] as Map<string, Job>;
}

const queuedTooLong = (job: Job, now: number) => job.state === 'queued' && now - job.createdAt > QUEUED_START_MS;
const isUnfinished = (job: Job, now: number) => job.state === 'running' || (job.state === 'queued' && !queuedTooLong(job, now));

/** Give up on a scan that has run past JOB_RUN_CEILING_MS: failed from then on, so it stops counting and a late settle is ignored. */
function expireOverrun(job: Job, now: number): void {
  if (job.state !== 'running' || job.startedAt === undefined || now - job.startedAt <= JOB_RUN_CEILING_MS) return;
  job.state = 'failed';
  job.error = SCAN_TOO_LONG;
  job.finishedAt = job.startedAt + JOB_RUN_CEILING_MS;
}

function prune(store: Map<string, Job>, now: number): void {
  for (const job of store.values()) expireOverrun(job, now);
  for (const [id, job] of store) {
    const forgotten = job.state === 'running' ? false
      : job.state === 'queued' ? now - job.createdAt > JOB_TTL_MS
        : now - (job.finishedAt ?? job.createdAt) > JOB_TTL_MS;
    if (forgotten) store.delete(id);
  }
  // Map iterates in insertion order, so the first finished entry is the oldest.
  for (const [id, job] of store) {
    if (store.size < MAX_ENTRIES) break;
    if (!isUnfinished(job, now)) store.delete(id);
  }
}

/** Which cap, if any, is full for `companyId` right now. Prunes first; registers nothing. */
function capacityRefusal(store: Map<string, Job>, companyId: string, now: number): CapacityRefusal | null {
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
  return null;
}

/** Whether a new job would be admitted, without registering one (the route checks before it charges an AI unit). */
export function checkVlmExtractCapacity(companyId: string, now: number = Date.now()): CapacityRefusal | null {
  return capacityRefusal(jobs(), companyId, now);
}

/** Register a job for `companyId`/`userId` as 'queued', or say which cap refused it. */
export function registerVlmExtractJob(companyId: string, userId: string, now: number = Date.now()): RegisterResult {
  const store = jobs();
  const refused = capacityRefusal(store, companyId, now);
  if (refused) return refused;
  const jobId = randomUUID();
  store.set(jobId, { companyId, userId, state: 'queued', createdAt: now });
  return { jobId };
}

/**
 * Run `read` for a registered job and keep its outcome. Started after COMMIT.
 * Never throws: a failure is logged and the job ends 'failed' with a generic
 * message. A job that is gone, or waited out its start window, is not run.
 * `clock` is read when the read starts and when it settles.
 */
export async function runVlmExtractJob(
  jobId: string, read: () => Promise<ExtractedDocument>, clock: () => number = Date.now,
): Promise<void> {
  const job = jobs().get(jobId);
  if (!job || job.state !== 'queued' || queuedTooLong(job, clock())) {
    log.warn('vlmExtract: job is gone or did not start in time, not run', { jobId }, 'vlm-extract');
    return;
  }
  job.state = 'running';
  job.startedAt = clock();
  let extracted: ExtractedDocument | null = null;
  try {
    extracted = await read();
  } catch (err) {
    log.error('vlmExtract: read failed', { jobId, error: err instanceof Error ? err.message : String(err) }, 'vlm-extract');
  }
  expireOverrun(job, clock());
  if (job.state !== 'running') {
    log.warn('vlmExtract: scan settled after its ceiling, outcome ignored', { jobId }, 'vlm-extract');
    return;
  }
  if (extracted) {
    job.extracted = extracted;
    job.state = 'done';
  } else {
    job.error = SCAN_FAILED;
    job.state = 'failed';
  }
  job.finishedAt = clock();
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
