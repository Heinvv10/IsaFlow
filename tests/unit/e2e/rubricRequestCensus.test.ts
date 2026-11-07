/**
 * Census (master plan wave 4, MW; security review round 2, PR #1209): the rubric harness writes only through its guarded
 * Api. `guardWrites` wraps the Api's own write methods, so a write sent on the Api's raw Playwright context
 * (`api.ctx.post(...)`) or on a browser context's request (`context.request.post(...)`) skips the email-route refusal
 * and the sandbox-scope check. Reads (`.get`) and `storageState()` stay allowed.
 *
 * Reads the tracked tree (`git ls-files tests/e2e/rubric`): an untracked file is not seen.
 * Named limit: this is text, not a parse. A write spelled another way (`ctx['post'](`, a context held in another
 * variable name and called as `.post(`, a line break before `.post(`) is not seen; review owns those.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const UNGUARDED_WRITE = /\.ctx\.(post|put|delete|patch|fetch)\(|\brequest\.(post|put|delete|patch|fetch)\(/;

function unguardedWrites(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const hits: string[] = [];
  for (const { path, text } of files) {
    text.split('\n').forEach((line, i) => { if (UNGUARDED_WRITE.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`); });
  }
  return hits;
}

describe('rubric harness: no write outside the guarded Api', () => {
  it('the tracked harness sends none', () => {
    const paths = execFileSync('git', ['ls-files', 'tests/e2e/rubric'], { encoding: 'utf8' }).split('\n').filter((p) => p.endsWith('.ts'));
    expect(paths.length).toBeGreaterThan(5);
    expect(unguardedWrites(paths.map((path) => ({ path, text: readFileSync(path, 'utf8') })))).toEqual([]);
  });

  it.each([
    'await api.ctx.post(\'/api/accounting/invoice-email\', {})',
    'await api.ctx.put(url)', 'api.ctx.delete(x)', 'api.ctx.patch(x)', 'api.ctx.fetch(x, { method: \'POST\' })',
    'await context.request.post(\'/api/x\')', 'context.request.fetch(u)', 'page.request.delete(u)',
  ])('sees %s', (line) => {
    expect(unguardedWrites([{ path: 'x.ts', text: line }])).toHaveLength(1);
  });

  it.each(['await api.ctx.get(path)', 'await api.ctx.storageState()', 'await context.request.get(\'/api/auth/me\')', 'await api.post(\'/api/x\')'])(
    'allows %s', (line) => {
      expect(unguardedWrites([{ path: 'x.ts', text: line }])).toEqual([]);
    });
});
