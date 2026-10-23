/**
 * The IsaFlow cron units in scripts/ send CRON_SECRET to the app. Unit files
 * under /etc/systemd/system are world-readable, and so is every process's
 * argv (/proc/<pid>/cmdline): the secret must reach curl on stdin only, from
 * the EnvironmentFile (docs/runbooks/cron-secret-management-packs.md).
 *
 * Each unit's ExecStart is run for real through /bin/sh, after the unescaping
 * systemd applies ($$ -> $, %% -> %, then the C escapes of a single-quoted
 * word), with curl replaced by a stub that records its argv and stdin.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DIR = join(process.cwd(), 'scripts');
const UNITS = readdirSync(DIR).filter((f) => /^isaflow-.*\.service$/.test(f))
  .filter((f) => /cron-secret/i.test(readFileSync(join(DIR, f), 'utf8')));
const SECRET = 'unit-test-secret-0123456789abcdef';

/** The ExecStart command line, continuation lines joined, as systemd would hand it to /bin/sh. */
function execStart(unit: string): string[] {
  const text = readFileSync(join(DIR, unit), 'utf8').replace(/\\\n/g, ' ');
  const line = text.split('\n').find((l) => l.startsWith('ExecStart='))!.slice('ExecStart='.length);
  const m = /^\/bin\/sh -c '(.*)'\s*$/.exec(line);
  if (!m) throw new Error(`${unit}: ExecStart is not /bin/sh -c '...'`);
  return ['/bin/sh', '-c', m[1]!.replace(/\$\$/g, '$').replace(/%%/g, '%').replace(/\\\\/g, '\\')];
}

describe('IsaFlow cron units keep CRON_SECRET out of the unit file and out of argv', () => {
  it('finds the cron units (management-packs and its siblings)', () => {
    expect(UNITS).toEqual(expect.arrayContaining(['isaflow-management-packs.service', 'isaflow-dunning-send.service',
      'isaflow-ar-matview-refresh.service', 'isaflow-fraud-scan.service', 'isaflow-mirror-scan.service',
      'isaflow-sent-mirror-scan.service']));
  });

  it.each(UNITS)('%s reads the secret from the env file, not from the unit', (unit) => {
    const text = readFileSync(join(DIR, unit), 'utf8');
    expect(text).toMatch(/^EnvironmentFile=\/home\/velo\/isaflow\/\.env\.local$/m);
    expect(text).not.toMatch(/X-Cron-Secret: [A-Za-z0-9]{8,}/);
  });

  it.each(UNITS)('%s sends the header on curl\'s stdin, never in its argv', (unit) => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-unit-'));
    try {
      const stub = join(dir, 'curl');
      writeFileSync(stub, `#!/bin/sh\nprintf 'ARGV %s\\n' "$*" > "${dir}/argv"\ncat > "${dir}/stdin"\n`);
      chmodSync(stub, 0o755);
      const [sh, flag, script] = execStart(unit);
      const r = spawnSync(sh!, [flag!, script!.replace('/usr/bin/curl', stub)],
        { env: { PATH: '/usr/bin:/bin', CRON_SECRET: SECRET }, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe(`X-Cron-Secret: ${SECRET}\n`);
      const argv = readFileSync(join(dir, 'argv'), 'utf8');
      expect(argv).toMatch(/-H @- /);
      expect(argv).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
