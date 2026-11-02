/**
 * shards — prints how many shards the integration gate runs on this machine
 * (suiteRoute.ts shardCount: CPUs less one, at most 6, or CI_INT_SHARDS).
 *
 * Run: bun scripts/ci/integration/shards.ts
 */
import { availableParallelism } from 'node:os';
import { shardCount } from './suiteRoute';

try {
  process.stdout.write(`${shardCount(availableParallelism(), process.env.CI_INT_SHARDS)}\n`);
} catch (e) {
  process.stderr.write(`[integration] ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
