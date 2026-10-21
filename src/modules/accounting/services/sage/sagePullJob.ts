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
 * (sageApiPacer), and at most MAX_CONCURRENT_PULLS reads run at once, one per
 * company. A pull that finds no free slot fails at once with a message saying
 * to try again; the review route checks the same slots up front
 * (pullSlotRefusal), so that is the rare race.
 *
 * A read whose row leaves 'pulling' (discarded, or marked interrupted) stops at
 * its next Sage call, page or retry: before each, at most every CHECK_EVERY_MS,
 * the job asks the row (touchPull) and throws PullStopped when it is gone. On
 * every way out the client is disposed (the login dropped) and the slot freed.
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
/** How often a running read asks whether its row is still 'pulling' (every ~3 calls under the pacer). */
export const CHECK_EVERY_MS = 2_000;
export const BUSY_MESSAGE = 'IsaFlow is reading other Sage companies right now. Try again in a few minutes.';
export const STOPPING_MESSAGE = 'The previous Sage read for this company is still stopping. Try again in a minute.';
const GENERIC_FAILURE = 'IsaFlow could not finish reading from Sage. Try again, or use the file upload instead.';

/** The row left 'pulling' (discarded, or failed as interrupted): stop reading. */
class PullStopped extends Error {
  constructor() {
    super('the Sage read was stopped: its row is no longer pulling');
    this.name = 'PullStopped';
  }
}

interface PullSlots { active: number; companies: Set<string> }
const SLOTS = Symbol.for('isaflow.sagePullSlots');

/** Per PROCESS (globalThis), like the pacer: module state can be per server chunk. */
function slots(): PullSlots {
  const g = globalThis as typeof globalThis & { [SLOTS]?: PullSlots };
  return (g[SLOTS] ??= { active: 0, companies: new Set() });
}

/**
 * Why a read for `companyId` cannot start now, or null. A company holds at
 * most one slot: a read discarded a moment ago keeps its slot until it reaches
 * its next Sage call and stops, and a new one waits for that rather than take
 * the other slot from every other tenant.
 */
export function pullSlotRefusal(companyId: string): string | null {
  const s = slots();
  if (s.companies.has(companyId)) return STOPPING_MESSAGE;
  return s.active >= MAX_CONCURRENT_PULLS ? BUSY_MESSAGE : null;
}

function tryTakeSlot(companyId: string): (() => void) | null {
  if (pullSlotRefusal(companyId)) return null;
  const s = slots();
  s.active++;
  s.companies.add(companyId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    s.active--;
    s.companies.delete(companyId);
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
  const release = tryTakeSlot(companyId);
  if (!release) {
    const refusal = pullSlotRefusal(companyId) ?? BUSY_MESSAGE;
    job.client.dispose();
    await markPullFailed(companyId, pullId, refusal).catch((err: unknown) => {
      log.error('Sage pull: could not record the busy refusal', { pullId, error: err instanceof Error ? err.message : String(err) }, 'migration');
    });
    log.warn('Sage pull refused: no slot', { companyId, pullId, refusal }, 'migration');
    return;
  }
  // A sign of life that also says whether the row is still 'pulling'. A failed
  // write is not taken as "gone": the read goes on, and a row that stays
  // unwritable goes stale and reads as interrupted.
  let alive = true;
  let lastCheck = 0;
  const still = async (progress?: string) => {
    const pulling = await touchPull(companyId, pullId, progress).catch((err: unknown) => {
      log.warn('Sage pull heartbeat failed', { pullId, error: err instanceof Error ? err.message : String(err) }, 'migration');
      return true;
    });
    if (!pulling) alive = false;
  };
  // Asked before every Sage call, page and retry (sageApiClient).
  const guard = async () => {
    if (alive && Date.now() - lastCheck >= CHECK_EVERY_MS) {
      lastCheck = Date.now();
      await still();
    }
    if (!alive) throw new PullStopped();
  };
  const timer = setInterval(() => { void still(); }, HEARTBEAT_MS);
  const started = Date.now();
  try {
    const pull = await pullSageCompany(job.client, job.sageCompanyId, job.asAtDate, (step) => { void still(STEP_LABEL[step]); }, guard);
    const takeOn = buildSageTakeOn(pull, await readTakeOnContext(companyId, pull.asAtDate));
    const summary = summarise(takeOn);
    const saved = await markPullReady(companyId, pullId, pull, summary);
    log.info(saved ? 'Sage pull ready' : 'Sage pull finished after its row stopped pulling; result dropped', {
      companyId, pullId, sageCompanyId: job.sageCompanyId, ms: Date.now() - started, ...summary.counts, errors: summary.errors,
    }, 'migration');
  } catch (err) {
    if (err instanceof PullStopped) {
      log.info('Sage pull stopped: its row was discarded or failed meanwhile', { companyId, pullId, ms: Date.now() - started }, 'migration');
      return;
    }
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
    job.client.dispose(); // the login goes with the read
    release();
  }
}
