/**
 * Golden-paths quarantine (tests/e2e/golden-paths/helpers/quarantine.ts): a quarantined test names its tracking
 * issue, the real golden config leaves it out, and GOLDEN_RUN_QUARANTINED=1 brings it back.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import goldenConfig from '../../../playwright-golden.config';
import { allSpecFiles } from '../../e2e/golden-paths/helpers/devOnlySpecs';
import { quarantined, QUARANTINE_TAG } from '../../e2e/golden-paths/helpers/quarantine';

const ROOT = path.resolve(__dirname, '../../..');
const GOLDEN_DIR = path.join(ROOT, 'tests/e2e/golden-paths');

describe('quarantined()', () => {
  it('tags the test and links its tracking issue', () => {
    expect(quarantined(1270)).toEqual({
      tag: '@quarantine',
      annotation: { type: 'issue', description: 'https://github.com/Heinvv10/IsaFlow/issues/1270' },
    });
  });

  it('refuses a quarantine without a real issue number', () => {
    expect(() => quarantined(0)).toThrow(/tracking issue/);
    expect(() => quarantined(Number.NaN)).toThrow(/tracking issue/);
  });
});

describe('playwright-golden.config.ts', () => {
  it('leaves out a quarantined test and keeps the rest', () => {
    const invert = goldenConfig.grepInvert;
    expect(invert).toBeInstanceOf(RegExp);
    const re = invert as RegExp;
    expect(re.test(`y1 keyboard only ${QUARANTINE_TAG}`)).toBe(true);
    expect(re.test('y1 keyboard only')).toBe(false);
  });
});

describe('golden specs', () => {
  it('quarantine only through quarantined(<issue>), never the bare tag', () => {
    const offenders = allSpecFiles(GOLDEN_DIR).filter((f) => readFileSync(path.join(GOLDEN_DIR, f), 'utf8').includes(QUARANTINE_TAG));
    expect(offenders).toEqual([]);
  });
});

describe('a real playwright listing', () => {
  const list = (env: Record<string, string>, extra: string[] = []): string => {
    const dir = mkdtempSync(path.join(ROOT, '.golden-quarantine-')); // inside the repo so @playwright/test resolves
    const helper = JSON.stringify(path.join(GOLDEN_DIR, 'helpers/quarantine.ts'));
    writeFileSync(path.join(dir, 'zz.spec.ts'), `import { test } from '@playwright/test';\nimport { quarantined } from ${helper};\n` +
      `test('plain one', () => {});\ntest('held one', quarantined(1270), () => {});\n`);
    const cfg = path.join(dir, 'cfg.ts');
    writeFileSync(cfg, `import { defineConfig } from '@playwright/test';\nimport { quarantineGrepInvert } from ${helper};\n` +
      `export default defineConfig({ testDir: ${JSON.stringify(dir)}, grepInvert: quarantineGrepInvert(process.env) });\n`);
    try {
      return execFileSync('npx', ['playwright', 'test', '--list', '--config', cfg, ...extra], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, GOLDEN_RUN_QUARANTINED: '', ...env },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('skips the quarantined test, also when a chunk passes --grep', () => {
    for (const out of [list({}), list({}, ['--grep', 'one'])]) {
      expect(out).toContain('plain one');
      expect(out).not.toContain('held one');
    }
  }, 90_000);

  it('runs it again with GOLDEN_RUN_QUARANTINED=1', () => {
    expect(list({ GOLDEN_RUN_QUARANTINED: '1' })).toContain('held one');
  }, 90_000);
});
