/**
 * Fault injection for the CLI tests (bun --preload): at the first BEGIN of the process (the run's first request, after the --report
 * placeholder was written once the run lock was held) the --report path SAGE_BREAK_REPORT is replaced by a directory, so every later
 * write to it fails (EISDIR): a report that becomes unwritable DURING a run (round 15: one unwritable at the start refuses the run).
 */
import { mkdirSync, rmSync } from 'node:fs';
import pg from 'pg';

const path = process.env.SAGE_BREAK_REPORT ?? '';
let done = false;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  if (!done && path !== '' && args[0] === 'BEGIN') { done = true; rmSync(path, { force: true }); mkdirSync(path); }
  return (orig as (...a: unknown[]) => unknown).apply(this, args);
};
