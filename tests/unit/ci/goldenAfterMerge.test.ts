import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

type Step = { id?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  steps: Step[];
};

const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  concurrency: { group: string; 'cancel-in-progress': string };
  jobs: Record<string, Job>;
};
const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const job = (id: string) => workflow.jobs[id]!;
const runText = (id: string) => job(id).steps.map((step) => step.run ?? '').join('\n');

describe('Golden Paths smoke before merge and full suite after merge', () => {
  it('uses a per-sha workflow group for pushes, so later merges cannot cancel a running post-merge suite', () => {
    expect(workflow.concurrency.group).toContain("github.event_name == 'push' && github.sha");
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'push' }}");
  });

  it('runs the smoke subset in the PR job and keeps the legacy required name as a strict shim', () => {
    const smoke = job('golden-paths-smoke');
    const shim = job('golden-paths-shim');
    expect(smoke.name).toBe('Golden Paths smoke (blocking)');
    expect(runText('golden-paths-smoke')).toContain('bun run test:e2e:golden:smoke');
    expect(smoke.steps.some((step) => step.id === 'mq')).toBe(true);
    expect(shim).toMatchObject({
      name: 'Golden Paths E2E (blocking)',
      needs: 'golden-paths-smoke',
      if: '${{ always() }}',
    });
    const command = shim.steps.at(-1)!.run!;
    for (const [result, status] of [['success', 0], ['failure', 1], ['cancelled', 1], ['skipped', 1]] as const) {
      expect(spawnSync('/bin/bash', ['-c', command], { env: { ...process.env, SMOKE: result } }).status).toBe(status);
    }
  });

  it('runs the full suite only after a master push and never applies the already-tested skip', () => {
    const full = job('golden-paths-post-merge');
    expect(full.name).toBe('Golden Paths E2E (post-merge)');
    expect(full.if).toBe("${{ github.event_name == 'push' }}");
    expect(full.concurrency).toEqual({
      group: 'golden-paths-post-merge-${{ github.run_id }}',
      'cancel-in-progress': false,
    });
    expect(full.steps.some((step) => step.id === 'mq' || step.if?.includes('steps.mq'))).toBe(false);
    expect(runText('golden-paths-post-merge')).toContain('bun run test:e2e:golden $SHARD');
    expect(runText('golden-paths-post-merge')).not.toContain('test:e2e:golden:smoke');
  });

  it('reports the exact post-merge result on every push', () => {
    const report = job('golden-paths-report');
    expect(report.needs).toBe('golden-paths-post-merge');
    expect(report.if).toBe("${{ always() && github.event_name == 'push' }}");
    expect(report.steps[0]!.env!.RESULT).toBe('${{ needs.golden-paths-post-merge.result }}');
    expect(report.steps[0]!.run).toContain('Golden Paths E2E (post-merge)');
  });

  it('reports an older failure while a newer suite is still running', () => {
    const result = runReport('failure', 100, '');
    expect(result.status).toBe(1);
    expect(result.calls).toContain('issue create');
  });

  it('does not let an older success close a newer recorded failure', () => {
    const tracker = '12\tOPEN\tGolden red\\n<!-- golden-paths-run: 200/1 -->';
    const result = runReport('success', 100, tracker);
    expect(result.status).toBe(0);
    expect(result.calls).toContain('issue list');
    expect(result.calls).not.toContain('issue edit');
    expect(result.calls).not.toContain('issue close');
  });

  it('names four existing specs in the smoke script', () => {
    const specs = scripts['test:e2e:golden:smoke']!.split(/\s+/).filter((part) => part.endsWith('.spec.ts'));
    expect(specs).toHaveLength(4);
    for (const spec of specs) expect(existsSync(spec), spec).toBe(true);
  });
});

function reportCommand(): string {
  return job('golden-paths-report').steps[0]!.run!;
}

function runReport(result: string, runId: number, tracker: string): { status: number | null; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'golden-report-'));
  const gh = join(dir, 'gh');
  const calls = join(dir, 'calls');
  writeFileSync(gh, '#!/bin/bash\necho "$*" >> "$GH_FAKE_CALLS"\nif [ "$1 $2" = "issue list" ]; then printf "%s\\n" "$GH_FAKE_TRACKER"; fi\nif [ "$1 $2" = "issue create" ]; then echo "https://example.invalid/issues/99"; fi\n');
  chmodSync(gh, 0o755);
  const execution = spawnSync('/bin/bash', ['-c', reportCommand()], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GH_FAKE_CALLS: calls,
      GH_FAKE_TRACKER: tracker,
      GH_TOKEN: 'test',
      REPO: 'owner/repo',
      RESULT: result,
      RUN_ID: String(runId),
      RUN_ATTEMPT: '1',
      RUN_URL: `https://example.invalid/runs/${runId}`,
      COMMIT_URL: `https://example.invalid/commits/${runId}`,
      SUBJECT: 'test merge',
    },
  });
  const output = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { status: execution.status, calls: output };
}
