/**
 * A PRINT-PARITY TEST SKIPS ONLY ON GITHUB'S HOSTED RUNNERS OR WHEN TOLD TO, SAYING WHY, AND NEVER AGAINST ANOTHER IMAGE.
 */
import { describe, expect, it } from 'vitest';
import { PRODUCTION_GOTENBERG_IMAGE } from './gotenbergParity';
import { paritySkip } from './paritySkip';
import { parityOutOfScope } from './parityScope';

const host = (runningImage: string | null, missing: string | null, outOfScope: string | null = null) => ({ runningImage: () => runningImage, missing: () => missing, outOfScope: () => outOfScope });

describe('paritySkip', () => {
  it('runs where everything is there', () => {
    expect(paritySkip({}, host(PRODUCTION_GOTENBERG_IMAGE, null))).toBeNull();
    expect(paritySkip({}, host(null, null))).toBeNull();
  });

  it('fails a velo run that cannot run it, rather than skipping', () => {
    expect(() => paritySkip({}, host(null, 'docker is not on this machine'))).toThrow(/must run on velo/);
  });

  it('skips on GitHub\'s hosted runners, and when PARITY_OPTIONAL=1, saying why', () => {
    expect(paritySkip({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }, host(null, 'no image'))).toMatch(/no image \(a GitHub-hosted runner/);
    expect(paritySkip({ PARITY_OPTIONAL: '1' }, host(null, 'no image'))).toMatch(/no image; PARITY_OPTIONAL=1/);
  });

  it('fails on velo\'s SELF-hosted runner, which sets GITHUB_ACTIONS too, naming the actual cause', () => {
    expect(() => paritySkip({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }, host(null, 'this user (gha) has no access to the docker daemon')))
      .toThrow(/no access to the docker daemon.*must run on velo/);
  });

  it('fails when production\'s gotenberg container runs another image than the pinned one', () => {
    expect(() => paritySkip({}, host('sha256:0000', null))).toThrow(/not the pinned/);
    expect(() => paritySkip({ RUNNER_ENVIRONMENT: 'github-hosted' }, host('sha256:0000', 'no image'))).toThrow(/not the pinned/);
  });

  it('skips a push that touches nothing it holds, saying so, before asking for docker', () => {
    expect(paritySkip({}, host(null, 'no docker', 'PARITY_SCOPE=diff and this change touches no pack print file'))).toMatch(/touches no pack print/);
  });
});

describe('parityOutOfScope', () => {
  it('runs always unless PARITY_SCOPE=diff; with it, only for a change to what parity holds', () => {
    expect(parityOutOfScope({}, () => ['README.md'])).toBeNull();
    expect(parityOutOfScope({ PARITY_SCOPE: 'diff' }, () => ['README.md', 'src/modules/payroll/x.ts'])).toMatch(/touches no pack print/);
    for (const f of ['styles/packPrintPage.css', 'public/fonts/IBMPlexSans-Regular.woff2', 'src/modules/accounting/services/packs/pages/packFigureFit.ts',
      'tests/unit/printParity/gotenbergParity.ts', 'src/lib/pdf/printChromiumArgs.ts', 'bun.lock']) {
      expect(parityOutOfScope({ PARITY_SCOPE: 'diff' }, () => ['README.md', f]), f).toBeNull();
    }
  });
});
