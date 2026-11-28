/**
 * Fault injection for the CLI tests (bun --preload): at the first BEGIN of the process (after the run created its --report) the report is
 * moved to SAGE_MOVED_TO and the file SAGE_VICTIM is moved onto the report path: a file swapped in under a running run (round-17 B17-2).
 */
import { renameSync } from 'node:fs';
import pg from 'pg';

const [report, movedTo, victim] = [process.env.SAGE_REPORT ?? '', process.env.SAGE_MOVED_TO ?? '', process.env.SAGE_VICTIM ?? ''];
let done = false;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  if (!done && report !== '' && args[0] === 'BEGIN') { done = true; renameSync(report, movedTo); renameSync(victim, report); }
  return (orig as (...a: unknown[]) => unknown).apply(this, args);
};
