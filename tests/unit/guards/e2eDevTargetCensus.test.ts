/**
 * Every e2e spec goes through the one dev-target guard (tests/e2e/helpers/devTarget.ts). The only specs without it are
 * the golden specs the post-deploy verification runs (no `// golden:dev-only`; the list is pinned by
 * unit/ci/verifyCompanySandboxCensus and unit/scripts/verifyDeployA11yGate). Files are read as text, from disk.
 * Named limit: a URL assembled from pieces is not seen here; the runtime guard still judges baseURL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { devOnlySpecFiles, allSpecFiles } from '../../e2e/golden-paths/helpers/devOnlySpecs';

const ROOT = path.resolve(__dirname, '../../..');
const E2E = path.join(ROOT, 'tests/e2e');
const GOLDEN = path.join(E2E, 'golden-paths');

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return e.name.startsWith('.') || e.name === 'node_modules' ? [] : walk(path.join(dir, e.name));
  return e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [];
});
const rel = (f: string): string => path.relative(E2E, f).split(path.sep).join('/');

const devOnly = new Set(devOnlySpecFiles(GOLDEN));
const prodVerify = new Set(allSpecFiles(GOLDEN).filter((f) => !devOnly.has(f)).map((f) => `golden-paths/${f}`));
const files = walk(E2E).map(rel);
const specs = files.filter((f) => /\.(spec|test|setup)\.ts$/.test(f));
const read = (f: string): string => readFileSync(path.join(E2E, f), 'utf8');
/** The source without its comment lines. */
const code = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');

export function isGuarded(src: string): boolean {
  return /^guardDevTarget\((test|setup)\);$/m.test(src) && /import \{[^}]*\bguardDevTarget\b[^}]*\} from '[./]+(helpers\/)?(helpers\/)?devTarget';/.test(src);
}

/** What a file may not say for itself: a production address, or its own idea of which hosts and ports are safe. */
export const OWN_TARGET: ReadonlyArray<readonly [string, RegExp]> = [
  ['a production URL', /https?:\/\/(?:[\w-]+\.)*isaflow\.co\.za|\/\/(?:localhost|127\.0\.0\.1):(?:80|443|3101|3111|3112)\b/],
  ['its own port check', /\.port\s*(?:!==|===|!=|==)|\bDEV_PORTS\b|\bdevPorts\b/],
  ['its own host check', /hostname[^\n]*(?:toBe\(|===|!==)\s*'localhost'|hostname,[^\n]*toBe\('localhost'\)/],
  ['a baseURL override', /test\.use\(\{[^}]*\bbaseURL\b/],
  ['an unjudged URL from the env', /(?<!devBaseUrl\()process\.env\.(?:E2E_BASE_URL|BASE_URL)\b/],
];
/** Files whose job is to judge or map hosts. Each entry names the rules it is excused from, and why. */
const EXCUSED: Record<string, readonly string[]> = {
  'helpers/devTarget.ts': ['its own port check', 'an unjudged URL from the env'], // the guard
  'rubric/_rubricGuard.ts': ['its own host check', 'its own port check'], // stricter: localhost:3271-3280 only
  'rubric/_rubricDatabaseGuard.ts': ['its own port check'], // stricter: pins the dev database's port
  'golden-paths/helpers/hostedFeatureFlag.ts': ['its own host check'], // stricter: writes only the hosted run's own database
  'golden-paths/helpers/hostedOnboardingLimit.ts': ['its own host check'], // the same
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
    expect(hit("const BASE = 'https://app.isaflow.co.za';")).toEqual(['a production URL']);
    expect(hit("baseURL: 'http://localhost:3111',")).toEqual(['a production URL']);
    expect(hit('const A = process.env.E2E_BASE_URL;')).toEqual(['an unjudged URL from the env']);
    expect(hit('const A = devBaseUrl(process.env.E2E_BASE_URL);')).toEqual([]);
    expect(isGuarded("import { guardDevTarget } from './helpers/devTarget';\ntest.describe('x', () => {\n  guardDevTarget(test);\n});\n")).toBe(false);
    expect(isGuarded("import { guardDevTarget } from '../helpers/devTarget';\nguardDevTarget(test);\n")).toBe(true);
  });

  const configs = readdirSync(ROOT).filter((f) => /^playwright.*\.config\.ts$/.test(f));

  it.each(configs)('%s refuses a production target before any spec runs', async (name) => {
    const config = (await import(path.join(ROOT, name))).default as { globalSetup?: string };
    const expected = name === 'playwright-golden.config.ts' ? 'golden-paths/_global-setup.ts' : 'helpers/devTargetGlobalSetup.ts';
    expect(config.globalSetup).toBe(`./tests/e2e/${expected}`);
  });

  it('the golden global setup applies the guard to every run but the post-deploy one', () => {
    expect(read('golden-paths/_global-setup.ts')).toContain("if (process.env.GOLDEN_SKIP_A11Y !== '1') assertDevOrCiTarget(baseURL);");
  });

  it('no config defaults to a production address', () => {
    for (const name of configs) expect(code(readFileSync(path.join(ROOT, name), 'utf8')), name).not.toMatch(OWN_TARGET[0]![1]);
  });
});
