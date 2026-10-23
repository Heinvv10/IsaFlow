/**
 * Guard for shared_merchant_patterns (migration 931) — the one table that holds data from MANY companies.
 *
 * rls-policy-coverage and the migration-rls gate check only tables with a company_id column, so they
 * cannot see this one. This source-text census pins what they would miss:
 *   1. its columns: exactly the six it needs, none that could name a company, bureau, user, transaction,
 *      amount, description or account;
 *   2. FORCE RLS, no policy, no GRANT on the table in any migration, and no later migration touching it;
 *   3. its two doors: only sharedPoolJob.ts calls shared_pool_publish, only sharedSuggestionService.ts calls
 *      shared_pool_lookup, and no source file reads or writes the table by name.
 * The behaviour (grants, CHECKs, deny-all for app_user / platform_admin) is proved against a real database
 * in tests/integration/shared-merchant-patterns.int.test.ts. A failure here means: read the new code, and
 * if it is right, change this list in the same PR with the reason; never widen it to make it pass.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const MIGRATION = 'scripts/migrations/sql/931_shared_merchant_patterns.sql';
const read = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');
/** The text without comments (SQL `--`, TS `//` and block comments), so prose about a function is not a call. */
const code = (f: string) => read(f)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  .replace(/--.*$/gm, '');

/** Tracked AND untracked files (a census over `git ls-files` alone passes a file nobody has added yet). */
function files(...dirs: string[]): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...dirs], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => f.length > 0);
}

function tableColumns(sql: string): string[] {
  const m = /CREATE TABLE IF NOT EXISTS shared_merchant_patterns \(([\s\S]*?)\n\);/.exec(sql);
  if (!m) throw new Error('CREATE TABLE shared_merchant_patterns not found in 931');
  return m[1]!.split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+\s/.test(l)).map((l) => l.split(/\s+/)[0]!);
}

describe('shared_merchant_patterns — columns', () => {
  const cols = tableColumns(read(MIGRATION));

  it('has exactly the columns the pool needs', () => {
    expect(cols).toEqual([
      'normalized_merchant', 'category_code', 'distinct_company_count', 'agreement_pct', 'total_observations',
      'filter_version', 'updated_at',
    ]);
  });

  it('has no column that could identify a tenant, a person, a transaction or an account', () => {
    const forbidden = /(^|_)(company_id|bureau|user|actor|tx|txn|transaction|amount|description|account|gl|email|phone|name|reference|ref|raw|journal|contact|supplier|customer|client)(_|$)/;
    expect(cols.filter((c) => c !== 'distinct_company_count' && forbidden.test(c))).toEqual([]);
  });
});

describe('shared_merchant_patterns — access in the migrations', () => {
  const sql = code(MIGRATION);

  it('931 forces RLS and creates no policy and no grant on the table', () => {
    expect(sql).toContain('ALTER TABLE public.shared_merchant_patterns ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE public.shared_merchant_patterns FORCE ROW LEVEL SECURITY;');
    expect(sql).not.toMatch(/CREATE POLICY[^;]*shared_merchant_patterns/);
    expect(sql).not.toMatch(/\bGRANT\b[^;]*\bON\s+(TABLE\s+)?(public\.)?shared_merchant_patterns/);
  });

  it('931 grants publish to migration_admin only and lookup to app_user only', () => {
    const grants = [...sql.matchAll(/^GRANT EXECUTE ON FUNCTION public\.(shared_pool_\w+)\([^)]*\) TO (\w+);$/gm)].map((m) => `${m[1]} -> ${m[2]}`);
    expect(grants).toEqual(['shared_pool_publish -> migration_admin', 'shared_pool_lookup -> app_user']);
  });

  it('no other migration mentions the table or its functions', () => {
    const others = files('scripts/migrations/sql').filter((f) => f !== MIGRATION && f.endsWith('.sql'))
      .filter((f) => /shared_merchant_patterns|shared_pool_publish|shared_pool_lookup/.test(read(f)));
    expect(others).toEqual([]);
  });
});

describe('shared_merchant_patterns — the only doors in the code', () => {
  const sources = files('src', 'pages', 'scripts', 'lib', 'utils').filter((f) => /\.(ts|tsx|js|mjs|sql)$/.test(f) && !f.startsWith('scripts/migrations/sql/'));

  it('no source file names the table in SQL', () => {
    const touch = /\b(FROM|JOIN|INTO|UPDATE|TABLE|TRUNCATE)\s+(public\.)?shared_merchant_patterns\b/i;
    expect(sources.filter((f) => touch.test(code(f)))).toEqual([]);
  });

  it('only the aggregation job calls shared_pool_publish', () => {
    expect(sources.filter((f) => /shared_pool_publish\s*\(/.test(code(f))))
      .toEqual(['src/modules/accounting/services/sharedPool/sharedPoolJob.ts']);
  });

  it('only the scoped reader calls shared_pool_lookup', () => {
    expect(sources.filter((f) => /shared_pool_lookup\s*\(/.test(code(f))))
      .toEqual(['src/modules/accounting/services/sharedPool/sharedSuggestionService.ts']);
  });
});
