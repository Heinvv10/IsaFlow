/**
 * The auto-accept worker (intercompany P2), behind `POST /api/cron/intercompany-auto-accept` (timer
 * `scripts/isaflow-intercompany-auto-accept.timer`). It accepts, as the RECEIVER, the invoice / credit-note messages that the
 * receiver's side has asked to have accepted automatically on an active GROUP connection. Accepting creates a DRAFT supplier
 * invoice / credit note; nothing is approved or posted, a person approves it in the usual way (the side form says so).
 *
 * WHO IT ACTS AS. The cron has no user and no company, and `intercompany_in_one_group` is false without a signed-in user (it
 * is no membership oracle), so the worker has its OWN definer path: `intercompany_auto_accept_queue` (migration 1013, app_service
 * only) lists the work: message, receiver company, and a write-role user of the receiver in good standing, after the same
 * group re-check on the pair at action time. For each message the worker then opens `withReceiverTx`: app_user with THAT user's
 * claims and the RECEIVER's company, and runs the same `acceptMessage` a person's click runs, which re-checks the connection,
 * the membership (`intercompany_in_one_group`, now answerable) and the guards. Nothing runs in the sender's context.
 *
 * ON WHICH LOGIN. The queue runs on the service pool's login (the only one that may call it). Every message then runs on the REQUEST pool's
 * login (receiverTx.ts), because the service login inherits app_service, whose policies are USING (true): a RESET ROLE inside the
 * receiver's transaction would read every tenant. FAIRNESS: the queue takes at most 10 messages per receiver per run, and stamps each
 * attempt (back-off up to an hour, at most 8 attempts), so one pair cannot starve the others and a deferring message never blocks the head.
 *
 * ONE MESSAGE, ONE TRANSACTION. A refusal (no supplier linked, a duplicate number, foreign currency, an unreadable payload) marks
 * the message `failed` with a plain sentence, in its own transaction, so it is not retried every run and a person sees why
 * (Accept in the inbox retries it by hand). A transient lock or serialisation fault leaves it pending for the next run.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { acceptMessage } from './acceptService';
import { ConnectionRefusal } from './connectionTypes';
import { markMessageFailed } from './handleService';
import { withReceiverTx } from './receiverTx';

export interface AutoAcceptRun {
  considered: number; accepted: number; failed: number; deferred: number;
  /** Deferred on an attempt at or past STUCK_AT: the same message keeps failing to run (a persistent fault, not a busy moment). */
  stuck: number;
}

const TRANSIENT = new Set(['55P03', '40001', '40P01', '57014']);
/** The queue stamps each attempt and backs off (1, 2, 4 ... 60 minutes, at most 8 attempts); from this attempt on a deferral is reported. */
export const STUCK_AT = 4;
/**
 * What the message's `error` says when the cause is not one of our own fixed sentences. The SENDER can read `error`, so it never holds
 * a service's or the database's text (which can name the receiver's accounts, ids or constraints); the detail is logged.
 */
export const GENERIC = 'Could not create the draft; the receiving company must review it.';

type Row = Record<string, unknown>;

export async function runAutoAccept(limit = 50): Promise<AutoAcceptRun> {
  // The service login, in its own autocommit statement: the claim (an attempt stamp) is committed before any message is touched.
  const queue = (await sql`
    SELECT message_id, to_company_id, actor_user_id, attempt FROM public.intercompany_auto_accept_queue(${limit}::INT, true)
  `) as Row[];
  const run: AutoAcceptRun = { considered: queue.length, accepted: 0, failed: 0, deferred: 0, stuck: 0 };
  for (const q of queue) {
    const principal = { userId: String(q.actor_user_id), companyId: String(q.to_company_id) };
    const messageId = String(q.message_id);
    try {
      await withReceiverTx(principal, () => acceptMessage(principal.userId, principal.companyId, messageId, {}, { auto: true }));
      run.accepted += 1;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code && TRANSIENT.has(code)) {
        run.deferred += 1;
        const attempt = Number(q.attempt);
        if (attempt >= STUCK_AT) {
          run.stuck += 1;
          log.error('Intercompany auto-accept keeps deferring', { companyId: principal.companyId, messageId, code, attempt }, 'intercompany');
        } else {
          log.warn('Intercompany auto-accept deferred', { companyId: principal.companyId, messageId, code, attempt }, 'intercompany');
        }
        continue;
      }
      const sentence = err instanceof ConnectionRefusal && err.safeForSender ? err.message : GENERIC;
      if (sentence === GENERIC) {
        log.warn('Intercompany auto-accept failed', {
          companyId: principal.companyId, messageId, code: code ?? null, error: err instanceof Error ? err.name : 'unknown', detail: err instanceof Error ? err.message.slice(0, 300) : '',
        }, 'intercompany');
      }
      try {
        const marked = await withReceiverTx(principal, async () => {
          await sql`SELECT set_config('app.intercompany_handled_via', 'auto', true)`;
          return markMessageFailed(principal.companyId, messageId, sentence);
        });
        if (marked) run.failed += 1;
      } catch (markErr) {
        log.error('Intercompany auto-accept: could not mark the message failed', { companyId: principal.companyId, messageId, error: markErr instanceof Error ? markErr.name : 'unknown' }, 'intercompany');
        run.deferred += 1;
      }
    }
  }
  if (run.stuck > 0) log.error('Intercompany auto-accept has messages it cannot run', { ...run }, 'intercompany');
  log.info('Intercompany auto-accept run', { ...run }, 'intercompany');
  return run;
}
