/**
 * allocateTransaction's `opts.reallocation` sets aside the D12 refusal and the 'imported' requirement for one line
 * (the D12 exception, reconciliationSessionLock.ts). It is passed by ONE caller, bankReallocationService, which holds
 * the line's session and row locks, re-links, reverses and asserts the bank leg unchanged. A source-text ratchet:
 * a second file passing `reallocation:` (comments stripped) fails here and must argue its way into the exception.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('allocateTransaction opts.reallocation census', () => {
  it('only bankReallocationService passes reallocation', () => {
    const files = execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((f) => /\.tsx?$/.test(f));
    const passing = files.filter((f) => /\breallocation\s*:/.test(code(readFileSync(resolve(ROOT, f), 'utf8'))));
    expect(passing).toEqual(['src/modules/accounting/services/bank/bankReallocationService.ts']);
  });
});
