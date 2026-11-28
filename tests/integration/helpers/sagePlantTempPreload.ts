/**
 * Fault injection for the CLI tests (bun --preload): at the first BEGIN of the process (after the run created its --report) files are
 * planted at every name `.<report>.<pid>.<ms>.tmp` for the next SAGE_PLANT_MS milliseconds (default 20000): the names round 16's temp
 * file could take (round-17 B17-1). Under the round-17 decision there is no temp file, so every planted file must survive.
 */
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import pg from 'pg';

const report = process.env.SAGE_REPORT ?? '';
const span = Number(process.env.SAGE_PLANT_MS ?? '20000');
let done = false;
const orig = pg.Client.prototype.query;
(pg.Client.prototype as unknown as { query: unknown }).query = function patched(this: pg.Client, ...args: unknown[]) {
  if (!done && report !== '' && args[0] === 'BEGIN') {
    done = true;
    const now = Date.now();
    for (let k = 0; k < span; k++) writeFileSync(join(dirname(report), `.${basename(report)}.${process.pid}.${now + k}.tmp`), `planted ${k}`);
  }
  return (orig as (...a: unknown[]) => unknown).apply(this, args);
};
