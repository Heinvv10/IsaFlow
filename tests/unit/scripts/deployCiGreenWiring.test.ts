/**
 * deploy.sh section 1a: the REAL lines of the CI gate run under bash with
 * $BUN replaced by a stub that logs its arguments and exits as each case asks
 * (running deploy.sh itself would deploy production). Only exit 10 from
 * deployCiGreen.ts may skip `bun run ci`; 0, 1, 127 and a crash must run it,
 * a failing `bun run ci` must still abort, and SKIP_CI=1 is unchanged.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const lines = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith('# 1a. CI gate'));
const end = lines.findIndex((l) => l === 'echo "Building production bundle..."');
const GATE = lines.slice(start, end).join('\n');

const dir = mkdtempSync(join(tmpdir(), 'deploy-ci-gate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const stub = join(dir, 'bun');
writeFileSync(stub, [
  '#!/bin/bash',
  'echo "$*" >> "$CALLS"',
  'case "$1" in',
  '  */scripts/lib/deployCiGreen.ts) exit "$GREEN_RC" ;;',
  '  run) exit "$CI_RC" ;;',
  'esac',
  'exit 99',
].join('\n'));
chmodSync(stub, 0o755);

let n = 0;
function gate(env: Record<string, string>) {
  const calls = join(dir, `calls-${++n}`);
  writeFileSync(calls, '');
  const r = spawnSync('bash', ['-c', `set -e\nBUN=${JSON.stringify(stub)}\nREPO_DIR=/repo\n${GATE}\necho GATE_PASSED`], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', CALLS: calls, GREEN_RC: '0', CI_RC: '0', ...env },
  });
  return { status: r.status, out: r.stdout, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('deploy.sh CI gate wiring', () => {
  it('finds the section', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(GATE).toContain('$BUN run ci');
  });

  it('skips bun run ci only on exit 10', () => {
    const r = gate({ GREEN_RC: '10' });
    expect(r.calls).toEqual(['/repo/scripts/lib/deployCiGreen.ts']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/local bun run ci skipped/);
    expect(r.out).toContain('GATE_PASSED');
  });

  it.each(['0', '1', '2', '11', '127', '139'])('runs bun run ci when the check exits %s', (rc) => {
    const r = gate({ GREEN_RC: rc });
    expect(r.calls).toEqual(['/repo/scripts/lib/deployCiGreen.ts', 'run ci']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Running CI gate (bun run ci)...');
  });

  it('still aborts the deploy when the full gate fails', () => {
    const r = gate({ GREEN_RC: '0', CI_RC: '1' });
    expect(r.calls).toEqual(['/repo/scripts/lib/deployCiGreen.ts', 'run ci']);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain('GATE_PASSED');
  });

  it('SKIP_CI=1 bypasses both, as before', () => {
    const r = gate({ SKIP_CI: '1', GREEN_RC: '0' });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('WARNING: SKIP_CI=1');
  });
});
