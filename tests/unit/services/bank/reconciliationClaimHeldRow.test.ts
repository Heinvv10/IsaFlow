/**
 * D11 round 6: the reconciliation claim's bulk UPDATEs run under the 5 s row-lock budget; a held line (55P03) AND a
 * deadlock victim (40P01) both become the typed `RowLockTimeoutError` (the HTTP route's 503, the MCP tool's retry
 * refusal), never raw driver text. An ordinary error passes through unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/als', () => ({
  als: { getStore: () => ({ client: { query: vi.fn().mockResolvedValue({ rows: [{ v: '0' }] }) } }) }, assertTxUsable: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(() => ''), { unsafe: vi.fn(() => '') }) }));

import { claimTransactionsForReconciliation } from '@/modules/accounting/services/bank/bankReconciliationClaim';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';

const tx = (err: unknown) => (vi.fn(async () => { throw err; }) as never);
const claim = (err: unknown) => claimTransactionsForReconciliation(tx(err), 'c', 'r', 'b', '2026-06-30');

describe('claimTransactionsForReconciliation under the row-lock budget', () => {
  it.each(['55P03', '40P01'])('a raw %s becomes RowLockTimeoutError', async (code) => {
    const err = Object.assign(new Error('deadlock detected: relation "bank_transactions"'), { code });
    await expect(claim(err)).rejects.toBeInstanceOf(RowLockTimeoutError);
  });
  it('an ordinary error passes through unchanged', async () => {
    const err = new Error('boom');
    await expect(claim(err)).rejects.toBe(err);
  });
});
