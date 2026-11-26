/**
 * Every e2e spec goes through the one dev-target guard (tests/e2e/helpers/devTarget.ts). The only specs without it are
 * the golden specs the post-deploy verification runs (no `// golden:dev-only`; the list is pinned by
 * unit/ci/verifyCompanySandboxCensus and unit/scripts/verifyDeployA11yGate). Files are read as text, from disk.
 * Named limits: a URL assembled from pieces, and a context a spec builds with a saved session it names indirectly, are
 * not seen here; the runtime guard still judges every test's baseURL and storageState.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { devOnlySpecFiles, allSpecFiles } from '../../e2e/golden-paths/helpers/devOnlySpecs';

const ROOT = path.resolve(__dirname, '../../..');
const E2E = path.join(ROOT, 'tests/e2e');
const GOLDEN = path.join(E2E, 'golden-paths');

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return e.name.startsWith('.') || e.name === 'node_modules' ? [] : walk(path.join(dir, e.name));
  return /\.[cm]?[jt]sx?$/.test(e.name) ? [path.join(dir, e.name)] : [];
});
const rel = (f: string): string => path.relative(E2E, f).split(path.sep).join('/');

const devOnly = new Set(devOnlySpecFiles(GOLDEN));
const prodVerify = new Set(allSpecFiles(GOLDEN).filter((f) => !devOnly.has(f)).map((f) => `golden-paths/${f}`));
const files = walk(E2E).map(rel);
/** Playwright's own default test files, plus the setup files. */
const specs = files.filter((f) => /\.(spec|test|setup)\.[cm]?[jt]sx?$/.test(f));
const read = (f: string): string => readFileSync(path.join(E2E, f), 'utf8');
/** The source without its comment lines. */
const code = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

/**
 * The guard is imported from devTarget and called, on the file's imported `test` (or `setup`), by the first top-level
 * statement that calls anything. Read as syntax: a call in a comment, a branch or a describe does not count.
 */
export function isGuarded(src: string): boolean {
  const file = ts.createSourceFile('spec.ts', src, ts.ScriptTarget.Latest, true);
  const imported = new Map<string, string>();
  for (const s of file.statements) {
    const named = ts.isImportDeclaration(s) ? s.importClause?.namedBindings : undefined;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) imported.set(el.name.text, ((s as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text);
  }
  if (!/^[./]+(helpers\/)*devTarget$/.test(imported.get('guardDevTarget') ?? '')) return false;
  const first = file.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression));
  const call = first && ((first as ts.ExpressionStatement).expression as ts.CallExpression);
  if (!call || call.expression.getText() !== 'guardDevTarget') return false;
  const arg = call.arguments[0]?.getText() ?? '';
  return (arg === 'test' || arg === 'setup') && imported.has(arg);
}

/**
 * The lines of every `test.use(...)` / `setup.use(...)` that could replace the guarded baseURL: one naming it, or one
 * whose keys cannot be read (not an object literal, a spread, a computed key). The runtime guard refuses a bad value too.
 */
export function baseUrlOverrides(src: string): number[] {
  const file = ts.createSourceFile('spec.ts', src, ts.ScriptTarget.Latest, true);
  const hits: number[] = [];
  const readable = (p: ts.ObjectLiteralElementLike): boolean => !ts.isSpreadAssignment(p) && !!p.name
    && !ts.isComputedPropertyName(p.name) && p.name.getText().replace(/['"]/g, '') !== 'baseURL';
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && /^(?:test|setup)\.use$/.test(node.expression.getText())) {
      const arg = node.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg) || !arg.properties.every(readable)) {
        hits.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

/** What a file may not say for itself: a production address, or its own idea of which hosts and ports are safe. */
export const OWN_TARGET: ReadonlyArray<readonly [string, RegExp]> = [
  ['a production URL', /(?:https?:)?\/\/(?:[\w-]+\.)*isaflow\.co\.za|\/\/[^/\s'"`]+:(?:80|443|3101|3111|3112)\b/i],
  ['a production session', /(?:prod|admin-qa)[\w-]*session\.json/i],
  ['its own port check', /\.port\s*(?:!==|===|!=|==)|\bDEV_PORTS\b|\bdevPorts\b/],
  ['its own host check', /hostname[^\n]*(?:toBe\(|===|!==)\s*'localhost'|hostname,[^\n]*toBe\('localhost'\)/],
  // Database URLs are judged by the guard itself; every other *URL from the env goes through devBaseUrl.
  ['an unjudged URL from the env', /(?<!devBaseUrl\()process\.env(?:\.|\[\s*['"`])(?!\w*(?:DATABASE|DB)_URL)\w*URL\b|\{[^}]*\b(?!\w*(?:DATABASE|DB)_URL)\w*URL\b[^}]*\}\s*=\s*process\.env/],
  ['an unjudged database connection', /\bnew (?:pg\.)?(?:Pool|Client)\((?!\{ connectionString: assertDevOrCiDatabaseUrl\()/],
  // A bare mapping sends https to 127.0.0.1:443, production's nginx on velo-server.
  ['a host mapped to loopback without a port', /host-resolver-rules=MAP \S+ (?:127\.0\.0\.1|localhost|\[::1\])(?!:)/],
  // It runs before the test-scoped guard can.
  ['a worker-scoped fixture', /\bscope:\s*['"`]worker['"`]/],
];
/** Files whose job is to judge or map hosts. Each entry names the rules it is excused from, and why. */
const EXCUSED: Record<string, readonly string[]> = {
  'helpers/devTarget.ts': ['its own port check', 'an unjudged URL from the env'], // the guard
  'rubric/_rubricGuard.ts': ['its own host check', 'its own port check'], // stricter: localhost:3271-3280 only
  'rubric/_rubricDatabaseGuard.ts': ['its own port check'], // stricter: pins the dev database's port
  'rubric/_rubricDb.ts': ['an unjudged database connection'], // the URL _rubricDatabaseGuard.ts proved
  // stricter: writes only the hosted run's own database
  'golden-paths/helpers/hostedFeatureFlag.ts': ['its own host check', 'an unjudged database connection'],
  'golden-paths/helpers/hostedOnboardingLimit.ts': ['its own host check', 'an unjudged database connection'], // the same
  'golden-paths/helpers/suitePreconditions.ts': ['its own host check'], // Secure cookies, also in the post-deploy run
  'golden-paths/helpers/adminConsole.ts': ['its own host check', 'a production URL', 'an unjudged URL from the env'], // z22, read-only, post-deploy
  'web-analytics-empty-spinner.spec.ts': ['a production URL'], // maps the admin host name onto the dev server under test
};

describe('e2e dev-target census', () => {
  it('sees the specs (sanity)', () => {
    expect(specs.length).toBeGreaterThan(100);
    expect(prodVerify.size).toBeGreaterThan(20);
  });

  it.each(specs.filter((f) => !prodVerify.has(f)))('%s calls guardDevTarget at top level', (f) => {
    expect(isGuarded(read(f)), `${f}: add guardDevTarget(test) from tests/e2e/helpers/devTarget`).toBe(true);
  });

  it.each([...prodVerify])('%s runs in the post-deploy verification, so it carries no dev guard', (f) => {
    expect(read(f)).not.toMatch(/guardDevTarget/);
  });

  it.each(files.filter((f) => f !== 'helpers/devTarget.ts'))('%s replaces no baseURL', (f) => {
    expect(baseUrlOverrides(read(f))).toEqual([]);
  });

  it('the override rule reads the keys', () => {
    expect(baseUrlOverrides("test.use({ viewport: { width: 1 }, storageState: 'x' });")).toEqual([]);
    for (const src of [
      "test.use({ baseURL: 'x' });", "test.use({ extraHTTPHeaders: { a: 'b' }, baseURL: B });", "test.use({ 'baseURL': B });",
      'test.use(opts);', 'setup.use({ ...x });', 'test.use({ [key]: B });',
    ]) expect(baseUrlOverrides(src), src).toEqual([1]);
  });

  it('every spec is a .ts file, the only kind the rules below are written for', () => {
    expect(specs.filter((f) => !f.endsWith('.ts'))).toEqual([]);
  });

  /** The post-deploy specs and everything they import: a dev-only check there turns production verification red. */
  const postDeployClosure = (): string[] => {
    const seen = new Set<string>();
    const queue = [...prodVerify];
    for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
      if (seen.has(f)) continue;
      seen.add(f);
      for (const { fileName } of ts.preProcessFile(read(f), true, true).importedFiles) {
        if (!fileName.startsWith('.')) continue;
        const base = path.posix.join(path.posix.dirname(f), fileName);
        const hit = [base, `${base}.ts`, `${base}/index.ts`].find((c) => files.includes(c));
        if (hit) queue.push(hit);
      }
    }
    return [...seen];
  };

  it('nothing the post-deploy verification loads applies the dev guard', () => {
    const closure = postDeployClosure();
    expect(closure.length).toBeGreaterThan(prodVerify.size);
    const applies = /\b(?:devBaseUrl|guardDevTarget|assertDevOr\w+|assertDevStorageState)\s*\(/;
    // The golden global setup applies it only outside the post-deploy run (unit/ci/goldenGlobalSetupPreconditions).
    const own = ['helpers/devTarget.ts', 'golden-paths/_global-setup.ts'];
    expect(closure.filter((f) => !own.includes(f) && applies.test(code(read(f))))).toEqual([]);
  });

  it('a script that launches its own browser takes its address from devBaseUrl', () => {
    const scripts = files.filter((f) => !specs.includes(f) && /chromium\.launch\(/.test(read(f)) && !f.startsWith('rubric/'));
    expect(scripts.length).toBeGreaterThan(5);
    expect(scripts.filter((f) => !/^const BASE_URL = devBaseUrl\(\);$/m.test(read(f)))).toEqual([]);
  });

  it.each(files)('%s names no target of its own', (f) => {
    const broken = OWN_TARGET.filter(([name, re]) => !EXCUSED[f]?.includes(name) && re.test(code(read(f)))).map(([name]) => name);
    expect(broken).toEqual([]);
  });

  it('the rules catch the guards that let a production colour in', () => {
    const hit = (src: string): string[] => OWN_TARGET.filter(([, re]) => re.test(src)).map(([name]) => name);
    expect(hit("expect(u.hostname === 'localhost' && u.port !== '3101', 'z').toBe(true);")).toContain('its own port check');
    expect(hit("expect(new URL(baseURL).hostname, 'z writes').toBe('localhost');")).toContain('its own host check');
    for (const url of ['https://app.isaflow.co.za', 'HTTPS://APP.ISAFLOW.CO.ZA', '//admin.isaflow.co.za/x', 'http://localhost:3111',
      'http://100.96.203.105:3101', 'http://[::1]:3111', 'http://0.0.0.0:3112']) {
      expect(hit(`const BASE = '${url}';`), url).toEqual(['a production URL']);
    }
    for (const src of ['process.env.E2E_BASE_URL', "process.env['BASE_URL']", 'process.env.QA_BASE_URL', 'process.env.PROD_URL']) {
      expect(hit(`const A = ${src};`), src).toEqual(['an unjudged URL from the env']);
    }
    expect(hit('const { BASE_URL } = process.env;')).toEqual(['an unjudged URL from the env']);
    expect(hit('const A = devBaseUrl(process.env.E2E_BASE_URL);')).toEqual([]);
    expect(hit('const A = process.env.DATABASE_URL ?? process.env.GOLDEN_HOSTED_DB_URL;')).toEqual([]);
    expect(hit("storageState: 'tests/e2e/.auth/prod-session.json'")).toEqual(['a production session']);
    expect(hit('const p = new Pool({ connectionString: process.env.DATABASE_URL });')).toEqual(['an unjudged database connection']);
    expect(hit('const c = new pg.Client();')).toEqual(['an unjudged database connection']);
    expect(hit("{ scope: 'worker', auto: true }")).toEqual(['a worker-scoped fixture']);
    expect(hit("'--host-resolver-rules=MAP admin.example 127.0.0.1',")).toEqual(['a host mapped to loopback without a port']);
    expect(hit('`--host-resolver-rules=MAP admin.example 127.0.0.1:${PORT}`,')).toEqual([]);
  });

  it('a guard call counts only as the first top-level call, on the imported test', () => {
    const head = "import { test } from '@playwright/test';\nimport { guardDevTarget } from '../helpers/devTarget';\n";
    expect(isGuarded(`${head}guardDevTarget(test);\n`)).toBe(true);
    for (const body of [
      '/*\nguardDevTarget(test);\n*/\n', 'if (false) {\nguardDevTarget(test);\n}\n', "test.describe('x', () => {\n  guardDevTarget(test);\n});\n",
      "test.beforeAll(() => {});\nguardDevTarget(test);\n", 'const fake = { use: () => {} };\nguardDevTarget(fake);\n',
    ]) expect(isGuarded(head + body), body).toBe(false);
    expect(isGuarded("import { test } from '@playwright/test';\nimport { guardDevTarget } from './mine';\nguardDevTarget(test);\n")).toBe(false);
  });

  const configs = readdirSync(ROOT).filter((f) => /^playwright.*\.config\.ts$/.test(f));

  it.each(configs)('%s refuses a production target before any spec runs', async (name) => {
    const config = (await import(path.join(ROOT, name))).default as { globalSetup?: string };
    const expected = name === 'playwright-golden.config.ts' ? 'golden-paths/_global-setup.ts' : 'helpers/devTargetGlobalSetup.ts';
    expect(config.globalSetup).toBe(`./tests/e2e/${expected}`);
  });

  it('no config defaults to a production address', () => {
    for (const name of configs) expect(code(readFileSync(path.join(ROOT, name), 'utf8')), name).not.toMatch(OWN_TARGET[0]![1]);
  });
});
