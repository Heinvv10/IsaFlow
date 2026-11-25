/**
 * Intercompany P4-D round 2 (L12): a confirmed contra receipt's allocation cannot be unapplied or changed through the app. The only code
 * that deletes or rewrites `customer_payment_allocations` is the bank-allocation unwind (`bank/bankAllocationUnwind.ts`), which acts on a
 * receipt a BANK allocation created; a contra clearing has none (and its journal is reversed only by the receipt's cancel, which keeps the
 * allocation rows). A new writer must be added here deliberately.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('who deletes or rewrites customer_payment_allocations', () => {
  it('only the bank-allocation unwind (and the QA seed reset script)', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'pages', 'scripts/*.ts'], { encoding: 'utf8' })
      .split('\n').filter((f) => /\.(tsx?|mts|cts|mjs|cjs|js)$/.test(f));
    const writes = /(DELETE\s+FROM|UPDATE)\s+(public\.)?customer_payment_allocations\b/i;
    expect(files.filter((f) => writes.test(readFileSync(f, 'utf8'))).sort()).toEqual([
      'scripts/qa-seed/reset.ts', // the QA seed's reset of its own throwaway company (an operator script, never a request path)
      'src/modules/accounting/services/bank/bankAllocationUnwind.ts',
    ]);
  });

  it('the pattern is not vacuous', () => {
    const writes = /(DELETE\s+FROM|UPDATE)\s+(public\.)?customer_payment_allocations\b/i;
    expect(writes.test('await sql`UPDATE customer_payment_allocations SET amount_allocated = 1`')).toBe(true);
    expect(writes.test('DELETE FROM public.customer_payment_allocations WHERE x')).toBe(true);
  });
});
