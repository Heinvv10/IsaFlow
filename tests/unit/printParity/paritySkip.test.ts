/**
 * A PRINT-PARITY TEST SKIPS ONLY ON GITHUB'S HOSTED RUNNERS OR WHEN TOLD TO, SAYING WHY, AND NEVER AGAINST ANOTHER IMAGE.
 */
import { describe, expect, it } from 'vitest';
import { PRODUCTION_GOTENBERG_IMAGE } from './gotenbergParity';
import { paritySkip } from './paritySkip';

const host = (runningImage: string | null, missing: string | null) => ({ runningImage: () => runningImage, missing: () => missing });

describe('paritySkip', () => {
  it('runs where everything is there', () => {
    expect(paritySkip({}, host(PRODUCTION_GOTENBERG_IMAGE, null))).toBeNull();
    expect(paritySkip({}, host(null, null))).toBeNull();
  });

  it('fails a velo run that cannot run it, rather than skipping', () => {
    expect(() => paritySkip({}, host(null, 'docker is not on this machine'))).toThrow(/must run on velo/);
  });

  it('skips on GitHub\'s hosted runners, and when PARITY_OPTIONAL=1, saying why', () => {
    expect(paritySkip({ GITHUB_ACTIONS: 'true' }, host(null, 'no image'))).toMatch(/no image; GitHub/);
    expect(paritySkip({ PARITY_OPTIONAL: '1' }, host(null, 'no image'))).toMatch(/no image; PARITY_OPTIONAL=1/);
  });

  it('fails when production\'s gotenberg container runs another image than the pinned one', () => {
    expect(() => paritySkip({}, host('sha256:0000', null))).toThrow(/not the pinned/);
    expect(() => paritySkip({ GITHUB_ACTIONS: 'true' }, host('sha256:0000', 'no image'))).toThrow(/not the pinned/);
  });
});
