import { describe, it, expect, vi } from 'vitest';
import { selectResidualTxIds, type ResidualCandidate } from '@/modules/accounting/services/bank/llmCategorizationPass';

const c = (id: string, o: Partial<ResidualCandidate> = {}): ResidualCandidate => ({
  id, suggestedGlAccountId: null, suggestedConfidence: null, status: 'imported', ...o,
});

describe('selectResidualTxIds', () => {
  it('includes imported txs with no suggestion', () => {
    expect(selectResidualTxIds([c('a')], 200)).toEqual(['a']);
  });
  it('includes imported txs whose confidence is below MEDIUM (0.60)', () => {
    expect(selectResidualTxIds([c('a', { suggestedGlAccountId: 'gl', suggestedConfidence: 0.45 })], 200)).toEqual(['a']);
  });
  it('excludes confident suggestions (>= 0.60)', () => {
    expect(selectResidualTxIds([c('a', { suggestedGlAccountId: 'gl', suggestedConfidence: 0.7 })], 200)).toEqual([]);
  });
  it('excludes non-imported txs', () => {
    expect(selectResidualTxIds([c('a', { status: 'matched' })], 200)).toEqual([]);
  });
  it('caps the residual list at maxCalls', () => {
    expect(selectResidualTxIds([c('a'), c('b'), c('d')], 2)).toEqual(['a', 'b']);
  });
});
