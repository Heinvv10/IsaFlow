import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('playwright-golden.config.ts', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  const load = async (evidence: string | undefined) => {
    vi.resetModules();
    vi.stubEnv('GOLDEN_EVIDENCE', evidence as string);
    return (await import('../../../playwright-golden.config')).default;
  };

  it('puts the evidence settings in use, so a red spec records them (hosted CI)', async () => {
    const cfg = await load('1');
    expect(cfg.use).toMatchObject({ trace: 'retain-on-failure', screenshot: 'only-on-failure' });
    expect(cfg.retries).toBe(0);
  });

  it('records nothing for the production verify, which shares the config', async () => {
    expect((await load('')).use).toMatchObject({ trace: 'off', screenshot: 'off' });
  });
});
