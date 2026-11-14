/**
 * Runs chunk K of N of the Golden Paths suite (see goldenChunkPlan.ts) against the dev server at $BASE_URL, one
 * `playwright-golden` invocation per planned run. With <piece> <pieces> it runs only that contiguous part of the chunk
 * (the job restarts its dev server between parts). A red run does not stop the next one, so one red chunk lists every
 * red spec; the exit code is the first failure's. Nothing is retried.
 *
 *   bun scripts/ci/golden-hosted/run-chunk.ts <k> <n> [<piece> <pieces>]
 */
import { spawnSync } from 'node:child_process';
import { chunkSeconds, planChunk } from './goldenChunkPlan';

const [k, n, piece = 1, pieces = 1] = process.argv.slice(2).map(Number);
if (k === undefined || n === undefined || [k, n, piece, pieces].some(Number.isNaN)) {
  process.stderr.write('usage: run-chunk.ts <k> <n> [<piece> <pieces>]\n');
  process.exit(2);
}
const { items, invocations } = planChunk(process.cwd(), k, n, piece, pieces);
process.stdout.write(`chunk ${k} of ${n}, piece ${piece} of ${pieces}: ${items.length} planned items, ~${chunkSeconds(items)} s of test time, ${invocations.length} playwright run(s)\n`);
if (invocations.length === 0) {
  process.stderr.write(`::error::chunk ${k} of ${n} has nothing to run; the plan is broken (more chunks than specs?)\n`);
  process.exit(1);
}
let rc = 0;
for (const inv of invocations) {
  const args = ['run', 'test:e2e:golden', ...inv.files, ...(inv.grep === undefined ? [] : ['--grep', inv.grep])];
  const r = spawnSync('bun', args, { stdio: 'inherit' });
  if (rc === 0 && r.status !== 0) rc = r.status ?? 1;
}
process.exit(rc);
