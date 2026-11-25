/**
 * Intercompany P4-E (j).3, fix round 1 K: the loan-clearing permit is the shared payment guard's only exemption, and nothing at run time stops
 * a second module from minting one. This census makes the convention a gate: in the application code (src/, pages/, scripts/: every file on
 * disk, tracked or not) ONLY `payerLoanClearService.ts` names `mintLoanClearPermit`, besides the module that defines it. A test may import it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const DEFINER = 'src/modules/accounting/services/intercompany/loanClearPermit.ts';
const MINTER = 'src/modules/accounting/services/intercompany/payerLoanClearService.ts';
const SKIP = new Set(['node_modules', '.next', '.git', 'coverage']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (SKIP.has(name)) continue;
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) yield* walk(rel);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) yield rel.split(path.sep).join('/');
  }
}

describe('who mints the loan-clearing permit', () => {
  it('only payerLoanClearService.ts names mintLoanClearPermit (and its own module defines it)', () => {
    const hits = ['src', 'pages', 'scripts'].flatMap((dir) => [...walk(dir)])
      .filter((file) => /\bmintLoanClearPermit\b/.test(readFileSync(path.join(ROOT, file), 'utf8')));
    expect(hits.sort()).toEqual([DEFINER, MINTER].sort());
  });

  it('the minter mints exactly once, for the one posting', () => {
    const src = readFileSync(path.join(ROOT, MINTER), 'utf8');
    expect(src.match(/\bmintLoanClearPermit\(/g)).toHaveLength(1);
  });
});
