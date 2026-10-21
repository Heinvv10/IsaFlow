/**
 * The background read of one Sage company, for one 'pulling' sage_connect_pulls
 * row.
 *
 * Started by the review route through runAfterCommit, so it runs after the
 * row's INSERT has committed, outside any request and its transaction, as the
 * pool role without RLS: every statement it makes names the company
 * (sageTakeOnStore / sageTakeOnContext), and every write is fenced on the row
 * still being 'pulling'. The Sage client — and so the client's login — lives
 * in this job's closure only, for as long as the read runs; it is never
 * written anywhere, and no message stored or logged can contain it.
 *
 * Process-wide limits, since every tenant's pull uses IsaFlow's one Sage key
 * from this server's one IP: calls are spaced by the shared pacer
 * (sageApiPacer), and at most MAX_CONCURRENT_PULLS reads run at once. A pull
 * that finds no free slot fails at once with a message saying to try again;
 * the review route checks the same slots up front, so that is the rare race.
 *
 * Never throws. A failure ends the row 'failed' with a user-safe message; a
 * process that dies mid-read leaves it 'pulling' with an old heartbeat, which
 * readers report as interrupted (sageTakeOnStore).
 */
import { log } from '@/lib/logger';
import { SageApiError, type SageApiClient } from './sageApiClient';
import { pullSageCompany, SagePullTooLargeError, type PullStep } from './sageApiPullService';
import { buildSageTakeOn } from './sageTakeOnBuilder';
import { readTakeOnContext } from './sageTakeOnContext';
import { markPullFailed, markPullReady, touchPull } from './sageTakeOnStore';
import { summarise } from './sageTakeOnTypes';

export const MAX_CONCURRENT_PULLS = 2;
/** Well inside PULL_STALE_MINUTES (15): a quiet stretch of document calls still beats. */
export const HEARTBEAT_MS = 60_000;
export const BUSY_MESSAGE = 'IsaFlow is reading other Sage companies right now. Try again in a few minutes.';
const GENERIC_FAILURE = 'IsaFlow could not finish reading from Sage. Try again, or use the file upload instead.';

interface PullSlots { active: number }
const SLOTS = Symbol.for('isaflow.sagePullSlots');

/** Per PROCESS (globalThis), like the pacer: module state can be per server chunk. */
function slots(): PullSlots {
  const g = globalThis as typeof globalThis & { [SLOTS]?: PullSlots };
  return (g[SLOTS] ??= { active: 0 });
}

export function pullSlotFree(): boolean {
  return slots().active < MAX_CONCURRENT_PULLS;
}

function tryTakeSlot(): (() => void) | null {
  const s = slots();
  if (s.active >= MAX_CONCURRENT_PULLS) return null;
  s.active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.active--;
  };
}

const STEP_LABEL: Record<PullStep, string> = {
  company: 'Reading the company', accounts: 'Reading the chart of accounts', trial_balance: 'Reading the trial balance',
  customers: 'Reading customers', suppliers: 'Reading suppliers', documents: 'Reading unpaid invoices and bills',
};

/** What the row may say about `err`: Sage's own plain-language errors and the pull's size refusal; nothing else. */
function safeMessage(err: unknown): string {
  if (err instanceof SageApiError || err instanceof SagePullTooLargeError) return err.message;
  return GENERIC_FAILURE;
}

export interface SagePullJob {
  companyId: string;
  pullId: string;
  client: SageApiClient;
  sageCompanyId: number;
  asAtDate: string;
}

export async function runSagePull(job: SagePullJob): Promise<void> {
  const { companyId, pullId } = job;
  const beat = (progress?: string) => touchPull(companyId, pullId, progress).catch((err: unknown) => {
    log.warn('Sage pull heartbeat failed', { pullId, error: err instanceof Error ? err.message : String(err) }, 'migration');
  });
  const release = tryTakeSlot();
  if (!release) {
    await markPullFailed(companyId, pullId, BUSY_MESSAGE).catch((err: unknown) => {
      log.error('Sage pull: could not record the busy refusal', { pullId, error: err instanceof Error ? err.message : String(err) }, 'migration');
    });
    log.warn('Sage pull refused: every slot busy', { companyId, pullId }, 'migration');
    return;
  }
  const timer = setInterval(() => { void beat(); }, HEARTBEAT_MS);
  const started = Date.now();
  try {
    const pull = await pullSageCompany(job.client, job.sageCompanyId, job.asAtDate, (step) => { void beat(STEP_LABEL[step]); });
    const takeOn = buildSageTakeOn(pull, await readTakeOnContext(companyId));
    const summary = summarise(takeOn);
    const saved = await markPullReady(companyId, pullId, pull, summary);
    log.info(saved ? 'Sage pull ready' : 'Sage pull finished after its row stopped pulling; result dropped', {
      companyId, pullId, sageCompanyId: job.sageCompanyId, ms: Date.now() - started, ...summary.counts, errors: summary.errors,
    }, 'migration');
  } catch (err) {
    const message = safeMessage(err);
    if (message === GENERIC_FAILURE) {
      log.error('Sage pull failed unexpectedly', { companyId, pullId, error: err instanceof Error ? err.message : String(err) }, 'migration');
    } else {
      log.warn('Sage pull failed', { companyId, pullId, reason: message }, 'migration');
    }
    const recorded = await markPullFailed(companyId, pullId, message).catch((e: unknown) => {
      log.error('Sage pull: could not record the failure', { pullId, error: e instanceof Error ? e.message : String(e) }, 'migration');
      return false;
    });
    if (!recorded) log.info('Sage pull failure not recorded: the row had already left pulling', { pullId }, 'migration');
  } finally {
    clearInterval(timer);
    release();
  }
}
