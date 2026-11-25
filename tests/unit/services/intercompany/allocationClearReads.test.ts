/**
 * Intercompany P4-D, the reads the clearing trusts (fix round 1, F10): the liveness definer's answer is exactly one row, or the clearing stops
 * (a throw, never a defaulted "not found"); the cap and the payer's loan type are read as the definer gave them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rows: [] as unknown[], texts: [] as string[] }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async (strings: TemplateStringsArray) => { m.texts.push(strings.join('?')); return m.rows; }) }));

import { askLive, lockPayerCaps } from '@/modules/accounting/services/intercompany/allocationClearReads';

beforeEach(() => { m.rows = []; m.texts = []; });

describe('askLive', () => {
  it('one row: the answer as the definer gave it', async () => {
    m.rows = [{ live: true, reason: 'ok', cap: null, payer_loan_type: 'liability' }];
    expect(await askLive('m-1')).toEqual({ live: true, reason: 'ok', cap: null, payerLoanType: 'liability' });
    expect(m.texts.at(-1)).toMatch(/intercompany_allocation_clearable\(/);   // the full definer (M4), never the inbox's light one
    m.rows = [{ live: true, reason: 'ok', cap: 'already_cleared', payer_loan_type: null }];
    expect(await askLive('m-1')).toEqual({ live: true, reason: 'ok', cap: 'already_cleared', payerLoanType: null });
  });

  it('no row, or more than one: a throw (the clearing must not go on a defaulted answer)', async () => {
    await expect(askLive('m-1')).rejects.toThrow(/exactly one row/);
    m.rows = [{ live: true, reason: 'ok', cap: null, payer_loan_type: 'liability' }, { live: true, reason: 'ok', cap: null, payer_loan_type: 'liability' }];
    await expect(askLive('m-1')).rejects.toThrow(/exactly one row/);
  });
});

describe('lockPayerCaps', () => {
  it("takes the payer's advisory locks through the one helper the guard uses too", async () => {
    await lockPayerCaps('m-1');
    expect(m.texts.join('\n')).toMatch(/intercompany_allocation_cap_lock\(/);
  });
});
