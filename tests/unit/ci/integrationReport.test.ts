import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPORT = join(process.cwd(), 'scripts/ci/integration/report.sh');

describe('integration shard log reporting', () => {
  it('prints only failed shards and bounds both their lines and line width', () => {
    const work = mkdtempSync(join(tmpdir(), 'isaflow-integration-report-'));
    mkdirSync(join(work, 'c1'));
    mkdirSync(join(work, 'c2'));
    writeFileSync(join(work, 'c1', 'isaflow_test.log'), 'successful log must stay quiet\n');
    writeFileSync(join(work, 'c2', 'isaflow_test.log'), `old failure context\n${'x'.repeat(3000)}\nlast failure line\n`);

    const output = execFileSync('bash', ['-c', `
      source "$1"
      CI_INT_FAILURE_LOG_LINES=2 CI_INT_FAILURE_LOG_COLUMNS=100 \\
        report_integration_failure_logs "$2" 2 "2"
    `, 'bash', REPORT, work], { encoding: 'utf8' });

    expect(output).not.toContain('successful log must stay quiet');
    expect(output).not.toContain('old failure context');
    expect(output).toContain('shard 2/2, isaflow_test (failed; last 2 lines, 100 columns max)');
    expect(output).toContain(`${'x'.repeat(100)}\nlast failure line`);
    expect(Math.max(...output.split('\n').map((line) => line.length))).toBeLessThanOrEqual(100);
  });
});
