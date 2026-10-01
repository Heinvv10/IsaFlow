/**
 * R-175: two call sites must not share a rate-limit key while disagreeing
 * about its limit.
 *
 * One key is one row with one window. pages/api/portal/auth.ts (5 per 15 min)
 * and pages/api/accounting/portal/auth.ts (5 per 60 s) both used
 * `portal-auth:${ip}`: the 60-second caller kept resetting the row, so the
 * password login allowed about 60 guesses per 15 minutes instead of 5.
 *
 * Scope: every tracked .ts/.tsx/.js/.mjs file outside tests/ (`git ls-files`,
 * so a new file counts once it is tracked). The app's runtime code is all in
 * pages/ and src/; scanning the rest as well means a script or config file
 * that starts calling the limiter is seen too.
 *
 * Every call is resolved to the key PATTERN it produces (`${...}` becomes `*`),
 * including the keys the wrappers build, so a hand-written
 * `report:reports-pdf:co:${id}` is compared with checkReportRateLimit(id,
 * 'reports-pdf'). It fails closed: a call it cannot read must be pinned below
 * by file and by the text of its key, with a reason.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const NAMES = 'checkRateLimit|chargeRateLimit|checkAiRateLimit|checkSendRateLimit|checkReportRateLimit|withRateLimit|refundRateLimit';
const CALL = new RegExp(`\\b(${NAMES})\\(`, 'g');
/** The limiter's own files: they define these functions and build the wrapper keys. */
const OWN = ['src/lib/rateLimit.ts', 'src/lib/rateLimitCore.ts', 'src/lib/rateLimitQuota.ts'];
/** The one table of wrapper-applied buckets; its call is resolved from the table itself. */
const AUTO = 'src/lib/auth/autoRateLimit.ts';

/** Calls whose key or options are not literals at the call site: `file | key text` -> why it is safe. */
const PINNED: Record<string, string> = {
  'src/modules/accounting/services/share/shareResolver.ts | ipKey': 'share:ip: key built just above; options are file constants used nowhere else',
  'src/modules/accounting/services/share/shareResolver.ts | tokenKey': 'share:token: key built just above; options are file constants used nowhere else',
  "pages/api/accounting/annotations/index.ts | annotationRateLimitKey('list', user.id)": 'per-action, per-user name; default options',
  "pages/api/accounting/annotations/index.ts | annotationRateLimitKey('create', user.id)": 'per-action, per-user name; default options',
  "pages/api/accounting/annotations/[id]/resolve.ts | annotationRateLimitKey('resolve', user.id)": 'per-action, per-user name; default options',
  'src/lib/rateLimitQuota.ts | key': 'refunds a key this request charged, taken from the request context',
  'scripts/generate-closeout-report.mjs | ?': 'prose in a description string, not a call',
};

/**
 * Pairs of patterns where one, read as a glob, could produce the other's keys,
 * and why it cannot in fact. `A <> B` -> reason. Filled in below.
 */
const SAFE_OVERLAPS: Record<string, string> = {
  'portal-chat:* <> portal-chat:co:*:day': 'the first is keyed by an IP address, which is never `co:<uuid>:day`',
};

/**
 * checkAiRateLimit / checkSendRateLimit build `<kind>:<name>:co:<company>` (15 minutes) and the same
 * with `:day` (24 hours). The company id is a UUID from the session and holds no colon, so the
 * shorter key can never be the longer one.
 */
const isWrapperDayPair = (a: string, b: string) => /^(ai|send):[^:*]+:co:\*$/.test(a) && b === `${a}:day`;

interface Site { where: string; pattern: string; options: string }
interface Census { charges: Site[]; refunds: Site[]; unreadable: string[]; aliased: string[] }

const stripComments = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).replace(/(^|[ \t])\/\/.*$/gm, '');

/** Splits the text after a call's `(` into its top-level arguments. */
function splitArgs(text: string): string[] | null {
  const args: string[] = [];
  const stack: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (ch === top && text[i - 1] !== '\\') stack.pop();
    } else if (top === '`') {
      if (ch === '`') stack.pop();
      else if (ch === '$' && text[i + 1] === '{') { stack.push('${'); current += ch; i++; }
    } else if (ch === "'" || ch === '"' || ch === '`' || ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length === 0) { args.push(current.trim()); return args.filter((a) => a !== ''); }
      stack.pop();
    } else if (ch === ',' && stack.length === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += text[i]!;
  }
  return null;
}

/** `{ max: 5, windowSecs: 15 * 60 }` -> { max: 5, windowSecs: 900 }. Null when a value is not a number. */
function readOptions(literal: string | undefined, source: string, ignore: string[]): Record<string, number> | null {
  if (literal === undefined) return {};
  if (!/^\{[\s\S]*\}$/.test(literal)) return null;
  const out: Record<string, number> = {};
  for (const part of literal.slice(1, -1).split(',')) {
    if (part.trim() === '') continue;
    const m = /^\s*(\w+)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (!m) return null;
    if (ignore.includes(m[1]!)) continue;
    // A named constant counts only if this file defines it as a plain number.
    const expr = m[2]!.replace(/\b[A-Z][A-Z0-9_]*\b/g, (name) =>
      new RegExp(`const ${name} = ([0-9_]+);`).exec(source)?.[1] ?? name).replace(/_/g, '');
    if (!/^[0-9*\s]+$/.test(expr)) return null;
    out[m[1]!] = expr.split('*').reduce((product, n) => product * Number(n), 1);
  }
  return out;
}

/** A string or template literal with every interpolation replaced by `*`. Null when it is not a literal. */
function keyPattern(arg: string | undefined): string | null {
  const m = /^([`'"])([\s\S]*)\1$/.exec(arg ?? '');
  if (!m) return null;
  const pattern = m[1] === '`' ? m[2]!.replace(/\$\{[^}]*\}/g, '*') : m[2]!;
  return /^[*:]*$/.test(pattern) ? null : pattern;
}

const limit = (max: number, windowSecs: number) => `max=${max};windowSecs=${windowSecs}`;

/** The keys a call produces, with the limit each is held to. Null when the call cannot be read. */
function resolve(fn: string, args: string[], source: string): Array<[string, string]> | null {
  if (fn === 'checkRateLimit' || fn === 'chargeRateLimit') {
    const pattern = keyPattern(args[0]);
    const o = readOptions(args[1], source, ['cost']);
    return pattern && o && o.max !== undefined && o.windowSecs !== undefined ? [[pattern, limit(o.max, o.windowSecs)]] : null;
  }
  if (fn === 'refundRateLimit') {
    const pattern = keyPattern(args[0]);
    return pattern ? [[pattern, 'refund']] : null;
  }
  if (fn === 'withRateLimit') {
    const scope = keyPattern(args[2]);
    const o = readOptions(args[1], source, []);
    return scope && o && o.max !== undefined && o.windowSecs !== undefined ? [[`${scope}:ip:*`, limit(o.max, o.windowSecs)]] : null;
  }
  if (fn === 'checkReportRateLimit') {
    const name = keyPattern(args[1]);
    const o = readOptions(args[2], source, []);
    return name && o ? [[`report:${name}:co:*`, limit(o.max ?? 25, o.windowSecs ?? 900)]] : null;
  }
  // checkAiRateLimit / checkSendRateLimit: three buckets each, with the wrapper's defaults.
  const kind = fn === 'checkAiRateLimit' ? 'ai' : 'send';
  const [ip, co, day] = kind === 'ai' ? [20, 40, 300] : [30, 60, 500];
  const name = keyPattern(args[2]);
  const o = readOptions(args[3], source, ['count', 'refundUnused']);
  return name && o ? [
    [`${kind}:${name}:ip:*`, limit(o.ipMax ?? ip, 900)],
    [`${kind}:${name}:co:*`, limit(o.companyMax ?? co, 900)],
    [`${kind}:${name}:co:*:day`, limit(o.dailyMax ?? day, 86_400)],
  ] : null;
}

function census(files: Record<string, string>): Census {
  const out: Census = { charges: [], refunds: [], unreadable: [], aliased: [] };
  for (const [file, raw] of Object.entries(files)) {
    // Drop comments (they carry commas, slashes and names) but keep every newline.
    const source = stripComments(raw);
    // The whole module as a namespace, or loaded at run time, hides every call.
    for (const m of source.matchAll(/import\s*\*\s*as\s+\w+\s+from\s+['"]@\/lib\/rateLimit(?:Core)?['"]|(?:require|import)\(\s*['"]@\/lib\/rateLimit(?:Core)?['"]\s*\)/g)) {
      out.aliased.push(`${file} | ${m[0].trim()}`);
    }
    // Outside its import, a limiter function may appear only as a direct call.
    // Renamed, assigned, passed as a value or bound, it would be invisible to
    // the scan below, so refuse it rather than try to follow it.
    const body = source.replace(/import\s[^;]*?from\s+['"][^'"]+['"];?/g, (imp) =>
      (new RegExp(`\\b(?:${NAMES})\\s+as\\s`).test(imp) ? imp : imp.replace(/[^\n]/g, '')));
    for (const m of body.matchAll(new RegExp(`(?<![\\w.'"\`])(${NAMES})\\b(?!\\s*\\()[^\\n]{0,24}`, 'g'))) {
      out.aliased.push(`${file} | ${m[0].trim()}`);
    }
    if (file === AUTO) {
      // One table for withAuth and the bearer pipeline: each entry is a key `<key>:<company>`.
      for (const m of source.matchAll(/\{\s*prefix:\s*'[^']+',\s*key:\s*'([^']+)',\s*max:\s*(\d+),\s*windowSecs:\s*(\d+)\s*\}/g)) {
        out.charges.push({ where: `${file} (table)`, pattern: `${m[1]}:*`, options: limit(Number(m[2]), Number(m[3])) });
      }
      continue;
    }
    for (const match of source.matchAll(CALL)) {
      const args = splitArgs(source.slice(match.index! + match[0].length));
      const keys = args && resolve(match[1]!, args, source);
      const keyArg = args?.[match[1] === 'withRateLimit' ? 2 : match[1]!.endsWith('ReportRateLimit') ? 1 : /Ai|Send/.test(match[1]!) ? 2 : 0];
      if (!keys) { out.unreadable.push(`${file} | ${keyArg ?? '?'}`); continue; }
      const where = `${file}:${source.slice(0, match.index).split('\n').length}`;
      for (const [pattern, options] of keys) {
        (options === 'refund' ? out.refunds : out.charges).push({ where, pattern, options });
      }
    }
  }
  return out;
}

/** Key patterns held to more than one limit. */
function collisions(sites: Site[]): string[] {
  const byPattern = new Map<string, Site[]>();
  for (const site of sites) byPattern.set(site.pattern, [...(byPattern.get(site.pattern) ?? []), site]);
  return [...byPattern.entries()]
    .filter(([, group]) => new Set(group.map((s) => s.options)).size > 1)
    .map(([pattern, group]) => `${pattern} -> ${group.map((s) => `${s.where} {${s.options}}`).join(' vs ')}`);
}

/** True when `a`, read as a glob, matches some key that `b` produces. */
function covers(a: string, b: string): boolean {
  const glob = new RegExp(`^${a.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return glob.test(b.replace(/\*/g, 'x'));
}

/**
 * Pairs of DIFFERENT patterns at different limits where one could produce the
 * other's keys: `foo:*` and `foo:bar:*` are one row whenever the first one's
 * variable part is `bar:...`.
 */
function overlaps(sites: Site[]): string[] {
  const limits = new Map<string, Set<string>>();
  for (const s of sites) limits.set(s.pattern, (limits.get(s.pattern) ?? new Set()).add(s.options));
  const patterns = [...limits.keys()].sort();
  const out: string[] = [];
  for (let i = 0; i < patterns.length; i++) {
    for (let j = i + 1; j < patterns.length; j++) {
      const [a, b] = [patterns[i]!, patterns[j]!];
      const sameLimits = [...limits.get(a)!].join() === [...limits.get(b)!].join();
      if (sameLimits || isWrapperDayPair(a, b) || isWrapperDayPair(b, a)) continue;
      if (covers(a, b) || covers(b, a)) out.push(`${a} <> ${b}`);
    }
  }
  return out;
}

function trackedSources(): Record<string, string> {
  const listed = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files: Record<string, string> = {};
  for (const file of listed.split('\n')) {
    if (!/\.(tsx?|m?js)$/.test(file) || file.startsWith('tests/') || OWN.slice(0, 2).includes(file)) continue;
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    if (new RegExp(NAMES).test(text)) files[file] = text;
  }
  return files;
}

describe('rate-limit key census (R-175)', () => {
  const found = census(trackedSources());

  it('finds the call sites, including the keys the wrappers build', () => {
    expect(found.charges.length).toBeGreaterThan(100);
    expect(found.charges.map((s) => s.pattern)).toEqual(expect.arrayContaining([
      'portal-auth:*', 'afs-portal-magic-link:*', 'login:ip:*', 'login:email:*', 'invite-accept:*',
      'ai:nl-query:co:*:day', 'send:invoice-email:ip:*', 'report:reports-pdf:co:*', 'statement-bulk-email:attempts:*',
    ]));
  });

  it('no key pattern is held to two different limits', () => {
    expect(collisions(found.charges)).toEqual([]);
  });

  it('no pattern can produce another pattern\'s keys at a different limit, except the reasoned pairs', () => {
    expect(overlaps(found.charges)).toEqual(Object.keys(SAFE_OVERLAPS).sort());
  });

  it('the wrapper-applied buckets are read from their one table', () => {
    expect(found.charges.filter((s) => s.where === `${AUTO} (table)`)).toEqual([
      { where: `${AUTO} (table)`, pattern: 'reports:*', options: limit(60, 60) },
    ]);
  });

  it('every refund is on a key that some call site charges', () => {
    const charged = new Set(found.charges.map((s) => s.pattern));
    expect(found.refunds.map((s) => s.pattern)).toEqual(['invite-accept:*']);
    expect(found.refunds.filter((s) => !charged.has(s.pattern))).toEqual([]);
  });

  it('every call it cannot read is pinned, and every pin still matches a call', () => {
    expect([...new Set(found.unreadable)].sort()).toEqual(Object.keys(PINNED).sort());
  });

  it('no file reaches the limiter under another name', () => {
    expect(found.aliased).toEqual([]);
  });

  it('the detector goes red on what it was written for', () => {
    const synthetic = census({
      'a.ts': "await checkRateLimit(`portal-auth:${ip}`, { max: 5, windowSecs: 15 * 60 });",
      'b.ts': "const allowed = await checkRateLimit(`portal-auth:${ip}`, { max: 5, windowSecs: 60 });",
      'c.ts': "export default withRateLimit(withUserAuth(withCsrf(handler)), { max: 10, windowSecs: 900 }, 'x');\n"
        + "const W = 900;\nawait checkRateLimit(`x:ip:${getClientIp(req)}`, {\n  max: 10, // per IP\n  windowSecs: W,\n});",
      'd.ts': "await checkAiRateLimit(req, companyId, 'n', { dailyMax: 300, refundUnused: true });\nawait checkAiRateLimit(req, companyId, 'n', { dailyMax: 100 });",
      'e.ts': 'await checkRateLimit(key, { max: 1, windowSecs: 1 });\nawait checkRateLimit(`k:${a}`, opts);\nawait checkRateLimit(`${a}:${b}`, { max: 1, windowSecs: 1 });',
      // A hand-written key that lands on a wrapper's key, at another limit.
      'f.ts': "await checkReportRateLimit(companyId, 'reports-pdf');\nawait checkRateLimit(`report:reports-pdf:co:${companyId}`, { max: 500, windowSecs: 900 });",
      'g.ts': "import { checkRateLimit as rl } from '@/lib/rateLimit';\nimport * as limiter from '@/lib/rateLimit';\nconst check = checkRateLimit;\nconst m = await import('@/lib/rateLimit');",
      // Passed as a value, in an object, bound: none of these is a direct call.
      'i.ts': "import { checkRateLimit, withRateLimit } from '@/lib/rateLimit';\nconst deps = { check: checkRateLimit };\nrun(checkRateLimit);\nconst b = checkRateLimit.bind(null);\n// checkRateLimit in a comment is fine\nawait checkRateLimit(`ok:${id}`, { max: 1, windowSecs: 1 });",
      'j.ts': "await checkRateLimit(`foo:${ip}`, { max: 5, windowSecs: 60 });\nawait checkRateLimit(`foo:bar:${id}`, { max: 9, windowSecs: 60 });\nawait checkRateLimit(`baz:${id}`, { max: 9, windowSecs: 60 });\nawait checkRateLimit(`baz:qux:${id}`, { max: 9, windowSecs: 60 });",
      'h.ts': 'await refundRateLimit(`never-charged:${id}`, 1);',
    });

    expect(collisions(synthetic.charges)).toEqual([
      'portal-auth:* -> a.ts:1 {max=5;windowSecs=900} vs b.ts:1 {max=5;windowSecs=60}',
      'ai:n:co:*:day -> d.ts:1 {max=300;windowSecs=86400} vs d.ts:2 {max=100;windowSecs=86400}',
      'report:reports-pdf:co:* -> f.ts:1 {max=25;windowSecs=900} vs f.ts:2 {max=500;windowSecs=900}',
    ]);
    expect(synthetic.charges.filter((s) => s.pattern === 'x:ip:*').map((s) => s.options)).toEqual([limit(10, 900), limit(10, 900)]);
    expect(synthetic.unreadable).toEqual(['e.ts | key', 'e.ts | `k:${a}`', 'e.ts | `${a}:${b}`']);
    expect(synthetic.aliased).toEqual([
      "g.ts | import * as limiter from '@/lib/rateLimit'",
      "g.ts | import('@/lib/rateLimit')",
      "g.ts | checkRateLimit as rl } from '@/lib/rat",
      'g.ts | checkRateLimit;',
      'i.ts | checkRateLimit };',
      'i.ts | checkRateLimit);',
      'i.ts | checkRateLimit.bind(null);',
    ]);
    // `foo:*` can produce `foo:bar:...` at another limit; the baz pair share a limit.
    expect(overlaps(synthetic.charges)).toEqual(['foo:* <> foo:bar:*']);
    expect(synthetic.refunds.map((s) => s.pattern)).toEqual(['never-charged:*']);
  });
});
