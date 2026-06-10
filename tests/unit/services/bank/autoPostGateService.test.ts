import { describe, it, expect } from 'vitest';
import { evaluate, type AutoPostSettings, type GateTx } from '@/modules/accounting/services/bank/autoPostGateService';

const ON: AutoPostSettings = { enabled: true, minConfidence: 0.9, amountCap: 10000 };
const tx = (over: Partial<GateTx> = {}): GateTx => ({
  status: 'imported', amount: -500, suggestedGlAccountId: 'gl-1', ...over,
});

describe('evaluate — decision ladder', () => {
  it('skips when disabled', () => {
    expect(evaluate(tx(), 0.99, { ...ON, enabled: false })).toEqual({ outcome: 'skip', reason: 'disabled' });
  });

  it('skips when tx not imported', () => {
    expect(evaluate(tx({ status: 'allocated' }), 0.99, ON)).toEqual({ outcome: 'skip', reason: 'not eligible' });
  });

  it('skips when confidence below threshold', () => {
    expect(evaluate(tx(), 0.89, ON)).toEqual({ outcome: 'skip', reason: 'confidence too low' });
  });

  it('posts when confidence is exactly at threshold', () => {
    expect(evaluate(tx(), 0.9, ON)).toEqual({ outcome: 'post' });
  });

  it('skips when amount over cap', () => {
    expect(evaluate(tx({ amount: -10000.01 }), 0.99, ON)).toEqual({ outcome: 'skip', reason: 'over amount cap' });
  });

  it('posts when amount is exactly at the cap', () => {
    expect(evaluate(tx({ amount: -10000 }), 0.99, ON)).toEqual({ outcome: 'post' });
  });

  it('treats cap of 0 as uncapped', () => {
    expect(evaluate(tx({ amount: -999999 }), 0.99, { ...ON, amountCap: 0 })).toEqual({ outcome: 'post' });
  });

  it('skips suggestion-path tx with no target', () => {
    expect(evaluate(tx({ suggestedGlAccountId: null }), 0.99, ON)).toEqual({ outcome: 'skip', reason: 'no target' });
  });

  it('defers confidence + no-target rungs when confidence is null (provisional path)', () => {
    expect(evaluate(tx({ suggestedGlAccountId: null }), null, ON)).toEqual({ outcome: 'post' });
  });

  it('enforces status on the provisional path (null confidence)', () => {
    expect(evaluate(tx({ status: 'allocated' }), null, ON)).toEqual({ outcome: 'skip', reason: 'not eligible' });
  });

  it('still enforces enabled/status/cap on the provisional path', () => {
    expect(evaluate(tx({ amount: -20000, suggestedGlAccountId: null }), null, ON))
      .toEqual({ outcome: 'skip', reason: 'over amount cap' });
  });
});
