/**
 * How `browser-tests` (vitest.print.config.ts) splits over ci.yml's velo
 * matrix: `vitest run --shard=k/n` keeps the files this sequencer deals to part
 * k. vitest's own shard cuts the hash-sorted list into equal COUNTS of files,
 * and these files are far from equal: on a hosted runner (2026-11-14) one took
 * 416 s, three more 120-220 s, and most under a second, so a count cut could
 * stack them in one part. This deals longest-first by measured seconds
 * (print-seconds.json; an unlisted file counts FALLBACK_SECONDS), the same deal
 * as the integration shards (suiteRoute.ts assignShards). A stale or missing
 * entry costs wall time, never coverage: every file vitest resolved is dealt to
 * exactly one part. Re-measure when a slow print test lands.
 */
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { assignShards } from './integration/suiteRoute';

export const FALLBACK_SECONDS = 1;

/** The repo-relative paths of part `index` (1-based) of `count`, in path order. */
export function printShardFiles(
  files: string[], index: number, count: number, seconds: Readonly<Record<string, number>>,
): string[] {
  const sorted = [...files].sort();
  return assignShards(sorted.map((file) => ({ file })), count, seconds, FALLBACK_SECONDS)
    .filter((s) => s.shard === index).map((s) => s.file);
}

export class PrintShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const seconds = JSON.parse(readFileSync(join(root, 'scripts/ci/print-seconds.json'), 'utf8')) as Record<string, number>;
    const path = (spec: TestSpecification) => relative(root, spec.moduleId).split(sep).join('/');
    const mine = new Set(printShardFiles(files.map(path), shard.index, shard.count, seconds));
    return files.filter((spec) => mine.has(path(spec)));
  }
}
