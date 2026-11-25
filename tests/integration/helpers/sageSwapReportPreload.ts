/**
 * Fault injection for the CLI tests (bun --preload): at the first BEGIN of the process (after the run created its --report) the --report
 * path SAGE_SWAP_REPORT is replaced by a HARD LINK to SAGE_SWAP_TO (the export, say): the path swapped under a running run. The run must
 * never write through it.
 */
import { linkSync, rmSync } from 'node:fs';
import pg from 'pg';

const path = process.env.SAGE_SWAP_REPORT ?? '';
const to = process.env.SAGE_SWAP_TO ?? '';
let done = false;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  if (!done && path !== '' && to !== '' && args[0] === 'BEGIN') { done = true; rmSync(path, { force: true }); linkSync(to, path); }
  return (orig as (...a: unknown[]) => unknown).apply(this, args);
};
