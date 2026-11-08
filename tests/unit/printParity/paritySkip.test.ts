/**
 * A PRINT-PARITY TEST SKIPS ONLY INSIDE GITHUB ACTIONS OR WHEN TOLD TO, NAMING THE ACTUAL CAUSE, AND NEVER AGAINST ANOTHER IMAGE.
 */
import { describe, expect, it, vi } from 'vitest';
import { orphanedContainers, PRODUCTION_GOTENBERG_IMAGE, removeContainer } from './gotenbergParity';
import { log } from '@/lib/logger';
import { paritySkip } from './paritySkip';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boxReaders, sourceFiles } from './boxReaders';
import { PARITY_PATHS, parityOutOfScope } from './parityScope';

const host = (runningImage: string | null, missing: string | null, outOfScope: string | null = null) => ({ runningImage: () => runningImage, missing: () => missing, outOfScope: () => outOfScope });

describe('paritySkip', () => {
  it('runs where everything is there', () => {
    expect(paritySkip({}, host(PRODUCTION_GOTENBERG_IMAGE, null))).toBeNull();
    expect(paritySkip({}, host(null, null))).toBeNull();
  });

  it('fails a run outside GitHub Actions (local ci, pre-push) that cannot run it, rather than skipping', () => {
    expect(() => paritySkip({}, host(null, 'docker is not installed on this machine'))).toThrow(/docker is not installed.*Outside GitHub Actions it must run/);
    expect(() => paritySkip({ GITHUB_ACTIONS: 'false' }, host(null, 'no image'))).toThrow(/Outside GitHub Actions it must run/);
    expect(() => paritySkip({ RUNNER_ENVIRONMENT: 'self-hosted' }, host(null, 'no image'))).toThrow(/Outside GitHub Actions it must run/);
  });

  it('skips inside GitHub Actions on a hosted runner, saying it has no production image', () => {
    expect(paritySkip({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }, host(null, 'docker is not installed on this machine')))
      .toBe('docker is not installed on this machine (a GitHub-hosted runner, which has no production image)');
  });

  it('skips inside GitHub Actions on velo\'s SELF-hosted runner, naming the missing docker access, not "hosted"', () => {
    const reason = paritySkip({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }, host(null, 'this user (gha-isaflow) has no access to the docker daemon (not in the docker group)'));
    expect(reason).toBe('this user (gha-isaflow) has no access to the docker daemon (not in the docker group) (a self-hosted Actions runner)');
    expect(reason).not.toMatch(/GitHub-hosted|production image/);
  });

  it('skips on purpose outside Actions when PARITY_OPTIONAL=1, saying why', () => {
    expect(paritySkip({ PARITY_OPTIONAL: '1' }, host(null, 'no image'))).toBe('no image; PARITY_OPTIONAL=1');
  });

  it('fails when production\'s gotenberg container runs another image than the pinned one', () => {
    expect(() => paritySkip({}, host('sha256:0000', null))).toThrow(/not the pinned/);
    expect(() => paritySkip({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }, host('sha256:0000', 'no image'))).toThrow(/not the pinned/);
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

describe('PARITY_PATHS', () => {
  it('covers every source file that reads the measured content box, through re-exports and aliases, untracked ones too', () => {
    const root = process.cwd();
    const readers = boxReaders(root, sourceFiles(root));
    expect(readers.length).toBeGreaterThan(10);
    expect(readers.filter((f) => !PARITY_PATHS.some((p) => p.test(f)))).toEqual([]);
  });

  it('counts an untracked file git does not ignore', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'box-untracked-'));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
      execFileSync('git', ['init', '-q', root], { env });
      mkdirSync(path.join(root, 'src', 'new'), { recursive: true });
      writeFileSync(path.join(root, 'src', 'new', 'reader.ts'), 'export const x = 1;');
      writeFileSync(path.join(root, '.gitignore'), 'src/ignored.ts\n');
      writeFileSync(path.join(root, 'src', 'ignored.ts'), 'export const y = 1;');
      expect(sourceFiles(root)).toEqual(['src/new/reader.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds a reader through a re-export under an alias and through export *', () => {
    const files: Record<string, string> = {
      'src/modules/accounting/services/packs/pages/packTextMetrics.ts': 'export const PAGE_WIDTH_MM = 1;',
      'src/lib/a.ts': "export { PAGE_WIDTH_MM as WIDTH } from '@/modules/accounting/services/packs/pages/packTextMetrics';",
      'src/lib/b.ts': "export * from './a';",
      'src/other/reader.ts': "import { WIDTH } from '@/lib/b';\nexport const w = WIDTH;",
      'src/other/bystander.ts': "import { something } from '@/lib/b';",
    };
    const root = mkdtempSync(path.join(tmpdir(), 'box-readers-'));
    try {
      for (const [f, text] of Object.entries(files)) { mkdirSync(path.join(root, path.dirname(f)), { recursive: true }); writeFileSync(path.join(root, f), text); }
      expect(boxReaders(root, Object.keys(files))).toEqual(['src/lib/a.ts', 'src/lib/b.ts', 'src/modules/accounting/services/packs/pages/packTextMetrics.ts', 'src/other/reader.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('orphanedContainers', () => {
  it('is only a parity container whose run is gone, by its exact name', () => {
    const alive = (pid: number) => pid === 100;
    expect(orphanedContainers(['isaflow-print-parity-100', 'isaflow-print-parity-3484459', 'gotenberg', 'isaflow-print-parity-x', 'my-isaflow-print-parity-7'], alive))
      .toEqual(['isaflow-print-parity-3484459']);
  });
});

describe('removeContainer', () => {
  it('never throws when docker cannot remove the container: it logs, so a failed start keeps its own error', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const calls: string[][] = [];
      expect(() => removeContainer('isaflow-print-parity-1', (args) => { calls.push(args); throw new Error('Cannot connect to the Docker daemon'); })).not.toThrow();
      expect(calls).toEqual([['rm', '-fv', 'isaflow-print-parity-1']]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not remove'), expect.objectContaining({ name: 'isaflow-print-parity-1', error: 'Cannot connect to the Docker daemon' }), 'print-parity');
    } finally {
      warn.mockRestore();
    }
  });
});
