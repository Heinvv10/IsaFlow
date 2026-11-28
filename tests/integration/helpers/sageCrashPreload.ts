/**
 * Fault injection for the CLI tests (bun --preload, R30-6): one uncaught error at the Nth COMMIT of the process (SAGE_CRASH_AT_COMMIT),
 * outside every try, so the CLI's own crash handler (terminate) ends the run, with the real runner and its real sessions.
 *   - SAGE_CRASH_WHEN=in-flight (the default): the crash is raised on the next turn after that COMMIT is SENT, and the COMMIT's answer is
 *     handed on only after the crash has fired, so the batch is in flight when the run ends on every run. (Before, a local server could
 *     answer within the timer's millisecond: the runner then recorded the batch and stood in the next batch's lock check, nothing in
 *     flight; GitHub hit that order.)
 *   - SAGE_CRASH_WHEN=between: after that COMMIT, the run lock's next check ('SELECT 1', asked before the next batch is sent) has its
 *     answer held until a crash has fired: the run ends between two batches, nothing in flight (the order GitHub hit).
 */
import pg from 'pg';

const at = Number(process.env.SAGE_CRASH_AT_COMMIT ?? '0');
const when = process.env.SAGE_CRASH_WHEN ?? 'in-flight';
let commits = 0;
let armed = false; // between: the COMMIT was answered; the next run-lock check is the one held
/** The query's answer handed on only after a crash on a timer has fired (whatever the answer is). */
const afterCrash = (out: unknown): Promise<unknown> => {
  let fired: () => void = () => undefined;
  const crashed = new Promise<void>((resolve) => { fired = resolve; });
  setTimeout(() => { fired(); throw new Error(`injected crash at COMMIT ${at}`); }, 0);
  return Promise.resolve(out).then((v) => crashed.then(() => v), (e: unknown) => crashed.then(() => { throw e; }));
};
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  const out = (orig as (...a: unknown[]) => unknown).apply(this, args);
  if (armed && args[0] === 'SELECT 1') { armed = false; return afterCrash(out); }
  if (args[0] !== 'COMMIT' || ++commits !== at) return out;
  if (when === 'between') { Promise.resolve(out).then(() => { armed = true; }, () => undefined); return out; }
  return afterCrash(out); // in-flight: the batch is still in flight when the run ends
};
