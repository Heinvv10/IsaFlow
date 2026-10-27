import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { devOnlySpecFiles, devOnlySpecPattern } from '../../e2e/golden-paths/helpers/devOnlySpecs';

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-only-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('devOnlySpecPattern', () => {
  it('matches a spec with the marker in its first 15 lines and not an unmarked one', () => {
    const dir = dirWith({
      'a-marked.spec.ts': '// golden:dev-only\nimport x from "y";\n',
      'b-plain.spec.ts': '// nothing here\n',
    });
    const re = devOnlySpecPattern(dir)!;
    expect(re.test('tests/e2e/golden-paths/a-marked.spec.ts')).toBe(true);
    expect(re.test('b-plain.spec.ts')).toBe(false);
    expect(re.test('xa-marked.spec.ts')).toBe(false);
  });

  it('ignores the marker on line 16 or later, and a marker-lookalike', () => {
    const late = `${'// filler\n'.repeat(15)}// golden:dev-only\n`;
    const dir = dirWith({ 'late.spec.ts': late, 'near.spec.ts': '// golden:dev-only-ish\n' });
    expect(devOnlySpecFiles(dir)).toEqual([]);
    expect(devOnlySpecPattern(dir)).toBeUndefined();
  });

  it('escapes regex metacharacters in spec names', () => {
    const dir = dirWith({ 'a.b+c.spec.ts': '// golden:dev-only\n', 'aXb+c.spec.ts': '// plain\n' });
    const re = devOnlySpecPattern(dir)!;
    expect(re.test('a.b+c.spec.ts')).toBe(true);
    expect(re.test('aXb+c.spec.ts')).toBe(false);
  });

  it('finds a marked spec in a subdirectory, and not by a bare-name collision', () => {
    const dir = dirWith({ 'top.spec.ts': '// plain\n' });
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'sub', 'deep.spec.ts'), '// golden:dev-only\n');
    const re = devOnlySpecPattern(dir)!;
    expect(devOnlySpecFiles(dir)).toEqual(['sub/deep.spec.ts']);
    expect(re.test('sub/deep.spec.ts')).toBe(true);
    expect(re.test('top.spec.ts')).toBe(false);
  });

  it('scans the same files the golden config loads (testMatch glob)', async () => {
    const cfg = (await import('../../../playwright-golden.config')).default;
    expect(cfg.testMatch).toBe('**/*.spec.ts');
  });
});
