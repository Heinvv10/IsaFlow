/**
 * scripts/ci/integration/scope.ts: whether the integration gate runs for a
 * GitHub event. Skips only a Markdown-only change; every doubt runs it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { baseSha, changedFiles, decideScope, main, SKIP_EXIT } from '../../../scripts/ci/integration/scope';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('decideScope', () => {
  it('skips when every changed file is Markdown', () => {
    expect(decideScope(['CHANGELOG.md', 'docs/x/README.md', 'src/modules/ar/.claude.md', 'AGENTS.md']).run).toBe(false);
  });

  it.each([
    ['src/lib/neon.ts'],
    ['scripts/migrations/sql/903_x.sql'],
    ['docs/audits/remediation/K-004/historical-impact.sql'], // read by integration suites
    ['tests/unit/helpers/fixture.ts'], // imported by integration suites
    ['package.json'],
    ['bun.lock'],
    ['.github/workflows/ci.yml'],
    ['README.mdx'],
  ])('runs when %s changed beside Markdown, and names it', (f) => {
    const s = decideScope(['CHANGELOG.md', f]);
    expect(s.run).toBe(true);
    expect(s.run && s.triggers).toEqual([f]);
  });

  it('runs when nothing changed (nothing proves the tree equal)', () => {
    expect(decideScope([]).run).toBe(true);
  });
});

describe('baseSha', () => {
  it('pull_request: the base sha', () => {
    expect(baseSha({ GITHUB_EVENT_NAME: 'pull_request' }, { pull_request: { base: { sha: A } } })).toBe(A);
  });

  it('push: before, only when not forced', () => {
    expect(baseSha({ GITHUB_EVENT_NAME: 'push' }, { before: A, forced: false })).toBe(A);
    expect(() => baseSha({ GITHUB_EVENT_NAME: 'push' }, { before: A, forced: true })).toThrow(/forced/);
    expect(() => baseSha({ GITHUB_EVENT_NAME: 'push' }, { before: A })).toThrow(/forced/);
    expect(() => baseSha({ GITHUB_EVENT_NAME: 'push' }, { before: '0'.repeat(40), forced: false })).toThrow(/no usable/);
  });

  it('refuses other events and malformed shas', () => {
    expect(() => baseSha({ GITHUB_EVENT_NAME: 'workflow_dispatch' }, {})).toThrow(/not pull_request or push/);
    expect(() => baseSha({}, {})).toThrow();
    expect(() => baseSha({ GITHUB_EVENT_NAME: 'pull_request' }, { pull_request: { base: { sha: 'HEAD~1' } } })).toThrow(/no usable/);
    expect(() => baseSha({ GITHUB_EVENT_NAME: 'pull_request' }, null)).toThrow(/no usable/);
  });
});

describe('main (fail safe)', () => {
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/event.json' };
  const event = () => JSON.stringify({ pull_request: { base: { sha: B } } });
  const quiet = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  it('skips a Markdown-only diff', () => {
    const out = quiet();
    const git = (args: string[]) => (args[0] === 'diff' ? 'CHANGELOG.md\0docs/a.md\0' : '');
    expect(main(env, git, event)).toBe(SKIP_EXIT);
    expect(out.mock.calls.join('')).toMatch(/SKIP: all 2 changed file\(s\) are Markdown/);
    out.mockRestore();
  });

  it('runs and lists the files that made it run', () => {
    const out = quiet();
    const git = (args: string[]) => (args[0] === 'diff' ? 'CHANGELOG.md\0src/a.ts\0' : '');
    expect(main(env, git, event)).toBe(0);
    expect(out.mock.calls.join('')).toMatch(/RUN: 1 of 2[\s\S]*src\/a\.ts/);
    out.mockRestore();
  });

  it.each([
    ['git fails (shallow clone: base not present)', () => { throw new Error('fatal: bad object'); }, event],
    ['the event file is unreadable', () => '', () => { throw new Error('ENOENT'); }],
    ['the event file is not JSON', () => '', () => 'not json'],
  ])('runs when %s', (_label, git, readEvent) => {
    const out = quiet();
    expect(main(env, git as (a: string[]) => string, readEvent as (p: string) => string)).toBe(0);
    expect(out.mock.calls.join('')).toMatch(/RUN: could not work out what changed/);
    out.mockRestore();
  });

  it('runs when GITHUB_EVENT_PATH is unset', () => {
    const out = quiet();
    expect(main({ GITHUB_EVENT_NAME: 'pull_request' }, () => 'a.md\0', event)).toBe(0);
    out.mockRestore();
  });
});

describe('changedFiles against a real repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'int-scope-'));
  // A hook (pre-push) exports GIT_DIR; the temp repo must not inherit it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/x.ts'), 'export const x = 1;\n'.repeat(20));
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a rename from src/ to a .md lists the deleted source too, so it runs', () => {
    git(['mv', 'src/x.ts', 'x.md']);
    git(['commit', '-qm', 'rename']);
    const files = changedFiles(base, git);
    expect(files.sort()).toEqual(['src/x.ts', 'x.md']);
    expect(decideScope(files).run).toBe(true);
  });

  it('a base that is not in the repository throws (and main then runs)', () => {
    expect(() => changedFiles(A, git)).toThrow();
  });
});
