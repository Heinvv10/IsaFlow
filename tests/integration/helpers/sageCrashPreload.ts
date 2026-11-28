/**
 * Fault injection for the CLI tests (bun --preload, R30-6): one uncaught error at the Nth COMMIT of the process (SAGE_CRASH_AT_COMMIT),
 * outside every try, so the CLI's own crash handler (terminate) ends the run, with the real runner and its real sessions.
 *   - SAGE_CRASH_WHEN=in-flight (the default): the crash is raised on the next turn after that COMMIT is SENT, and the COMMIT's answer is
 *     handed on only after the crash has fired, so the batch is in flight when the run ends on every run. (Before, a local server could
 *     answer within the timer's millisecond: the runner then recorded the batch and stood in the next batch's lock check, nothing in
 *     flight; GitHub hit that order.)
 *   - SAGE_CRASH_WHEN=between: after that COMMIT, the run lock's next check ('SELECT 1', sageRunLock.ts check(), asked before the next
 *     batch is sent) has its answer held until a crash has fired: the run ends between two batches, nothing in flight (the order GitHub
 *     hit).
 * Each hold writes a marker line to stderr (`[sage-crash-preload] held ...`), which the tests expect: a hold that never fires (the lock
 * query reworded, a callback-style call) reads as such, never as an unexplained exit 0.
 */
import pg from 'pg';

const at = Number(process.env.SAGE_CRASH_AT_COMMIT ?? '0');
const when = process.env.SAGE_CRASH_WHEN ?? 'in-flight';
let commits = 0;
let armed = false; // between: the COMMIT was answered; the next run-lock check is the one held
/**
 * The query's answer (whatever it is) handed on only after a crash on a timer has fired. The crash timer throws; the hold is released
 * from a LATER timer turn that the crash timer schedules first, so the order does not rest on when the runtime runs the uncaughtException
 * handler against the microtask queue: the held query is still pending when the crash is handled.
 */
const afterCrash = (out: unknown, what: string): Promise<unknown> => {
  process.stderr.write(`[sage-crash-preload] held ${what} until the crash\n`);
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  setTimeout(() => { setTimeout(release, 0); throw new Error(`injected crash at COMMIT ${at}`); }, 0);
  return Promise.resolve(out).then((v) => released.then(() => v), (e: unknown) => released.then(() => { throw e; }));
};
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  const out = (orig as (...a: unknown[]) => unknown).apply(this, args);
  // A callback-style call answers through its callback, not a promise: it is handed on unheld (the migration's sessions and run lock
  // only use the promise form; the marker line then never appears and the test says so).
  if (args.some((a) => typeof a === 'function')) return out;
  if (armed && args[0] === 'SELECT 1') { armed = false; return afterCrash(out, 'the run lock check after COMMIT ' + at); }
  if (args[0] !== 'COMMIT' || ++commits !== at) return out;
  if (when === 'between') { Promise.resolve(out).then(() => { armed = true; }, () => undefined); return out; }
  return afterCrash(out, `COMMIT ${at}`); // in-flight: the batch is still in flight when the run ends
};
