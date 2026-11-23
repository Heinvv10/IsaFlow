import { describe, expect, it } from 'vitest';
import { goldenEvidence } from '../../e2e/golden-paths/helpers/goldenEvidence';

describe('goldenEvidence', () => {
  it('records a trace and a screenshot for red specs when GOLDEN_EVIDENCE=1', () => {
    expect(goldenEvidence({ GOLDEN_EVIDENCE: '1' })).toEqual({ trace: 'retain-on-failure', screenshot: 'only-on-failure' });
  });
  it('writes nothing otherwise (production verify shares the config)', () => {
    expect(goldenEvidence({})).toEqual({ trace: 'off', screenshot: 'off' });
    expect(goldenEvidence({ GOLDEN_EVIDENCE: '0' })).toEqual({ trace: 'off', screenshot: 'off' });
    expect(goldenEvidence({ GOLDEN_EVIDENCE: 'true' })).toEqual({ trace: 'off', screenshot: 'off' });
  });
  it('never uses on-first-retry: the suite runs with retries: 0, so it would record nothing', () => {
    expect(JSON.stringify([goldenEvidence({ GOLDEN_EVIDENCE: '1' }), goldenEvidence({})])).not.toContain('on-first-retry');
  });
});
