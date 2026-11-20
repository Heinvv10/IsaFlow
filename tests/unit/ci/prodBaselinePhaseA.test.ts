/**
 * scripts/ci/prod-baseline/phase-a.sh, its decisions before any cluster starts: the input checks and the
 * stale-branch guard. Every input is fabricated here (a scratch git repo and a fake baseline of `SELECT 1;`),
 * never the real production baseline. The guard runs in the scratch repo (the script works in the repository it
 * is started in), which has no scripts/ci/integration/, so a run that gets past every decision fails sourcing
 * pg-cluster.sh: that failure is how the "proceeds" case below is told apart from a skip.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/ci/prod-baseline/phase-a.sh');
let scratch = '';
let repo = '';
let base = '';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A fake baseline directory: gz, matching .sha256 (unless overridden) and meta. */
function fakeBaseline(meta: unknown, sha256Line?: string): void {
  const gz = gzipSync('SELECT 1;\n');
  writeFileSync(join(base, 'prod-baseline.sql.gz'), gz);
  writeFileSync(join(base, 'prod-baseline.sql.gz.sha256'), sha256Line ?? `${createHash('sha256').update(gz).digest('hex')}  prod-baseline.sql.gz\n`);
  writeFileSync(join(base, 'prod-baseline.meta.json'), JSON.stringify(meta));
}

/** null: PROD_BASELINE_DIR unset. */
function run(dir: string | null = base): { status: number | null; out: string; err: string } {
  const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV, TMPDIR: scratch };
  if (dir === null) delete env.PROD_BASELINE_DIR;
  else env.PROD_BASELINE_DIR = dir;
  const r = spawnSync('bash', [SCRIPT], { cwd: repo, encoding: 'utf8', env });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'phase-a-test-'));
  repo = join(scratch, 'repo');
  base = join(scratch, 'baseline');
  mkdirSync(repo);
  mkdirSync(base);
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'root');
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('phase-a.sh refuses bad input before anything else (exit 2)', () => {
  it('no PROD_BASELINE_DIR', () => {
    const r = run(null);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/PROD_BASELINE_DIR is not set/);
  });

  it('PROD_BASELINE_DIR that is not a directory', () => {
    const r = run(join(scratch, 'missing'));
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/is not a directory/);
  });

  it('a directory without the three files', () => {
    const r = run();
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/has no prod-baseline\.sql\.gz/);
  });

  it('a dump that does not match its checksum', () => {
    fakeBaseline({ release_sha: git('rev-parse', 'HEAD') }, `${'0'.repeat(64)}  prod-baseline.sql.gz\n`);
    const r = run();
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/does not match prod-baseline\.sql\.gz\.sha256/);
  });

  it('a checksum file that names another file (sha256sum -c would check that one instead)', () => {
    writeFileSync(join(base, 'other'), 'x');
    fakeBaseline({ release_sha: git('rev-parse', 'HEAD') }, `${createHash('sha256').update('x').digest('hex')}  other\n`);
    const r = run();
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/must hold exactly one line, for prod-baseline\.sql\.gz/);
  });

  it.each([
    ['no release_sha', {}],
    ['a release_sha that is not hex (it would be printed)', { release_sha: 'master; echo hi' }],
    ['a release_sha that is too short', { release_sha: 'abc12' }],
  ])('a meta file with %s', (_label, meta) => {
    fakeBaseline(meta);
    const r = run();
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/has no release_sha/);
  });
});

describe('phase-a.sh stale-branch guard', () => {
  it('skips with one ::notice:: and exit 0 when the branch does not contain the release', () => {
    git('checkout', '-q', '-b', 'release');
    git('commit', '-q', '--allow-empty', '-m', 'released on master later');
    const release = git('rev-parse', '--short=9', 'HEAD');
    git('checkout', '-q', 'master');
    git('commit', '-q', '--allow-empty', '-m', 'branch work');
    fakeBaseline({ release_sha: release });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe(`::notice::prod-baseline: this branch does not contain production's release ${release}; merge master to check its migrations against production's schema`);
    expect(r.err).toBe('');
  });

  it('fails (exit 1) when the release is no commit here even after trying origin master', () => {
    fakeBaseline({ release_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/release deadbeefdeadbeefdeadbeefdeadbeefdeadbeef .* is not a commit here, even after fetching origin master/);
  });

  it.each([
    ['is HEAD', () => git('rev-parse', 'HEAD')],
    ['is an ancestor of HEAD', () => { const r = git('rev-parse', 'HEAD'); git('commit', '-q', '--allow-empty', '-m', 'after'); return r; }],
  ])('goes on to build the cluster when the release %s', (_label, release) => {
    fakeBaseline({ release_sha: release() });
    const r = run();
    expect(r.out).not.toMatch(/::notice::/);
    // The scratch repo has no gate helpers: getting this far is what the case asserts.
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/scripts\/ci\/integration\/pg-cluster\.sh/);
  });
});
