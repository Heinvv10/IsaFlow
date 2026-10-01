/**
 * R-175 review round 1: two call sites must not share a rate-limit key while
 * disagreeing about its limit.
 *
 * One key is one row with one window. pages/api/portal/auth.ts (5 per 15 min)
 * and pages/api/accounting/portal/auth.ts (5 per 60 s) both used
 * `portal-auth:${ip}`: the 60-second caller kept resetting the row, so the
 * password login allowed about 60 guesses per 15 minutes instead of 5.
 *
 * This reads every tracked source file (`git ls-files`, so a new file counts
 * only once it is tracked), finds every limiter call, and fails when two of
 * them use the same static key prefix with different options. It fails closed:
 * a call it cannot read must be pinned below, by line, with a reason.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const CALL = /\b(checkRateLimit|checkAiRateLimit|checkSendRateLimit|checkReportRateLimit|withRateLimit)\(/g;

/** Calls whose key or options are not literals at the call site. `file:line` -> why it is safe. */
const PINNED: Record<string, string> = {
  'src/lib/auth/withAuth.ts:177': 'key and options both come from one AUTO_RATE_LIMIT entry',
  'src/lib/auth/bearerPipeline.ts:213': 'the same AUTO_RATE_LIMIT entry as withAuth, deliberately one bucket',
  'src/modules/accounting/services/share/shareResolver.ts:88': 'share:ip: key built two lines above; options are file constants used nowhere else',
  'src/modules/accounting/services/share/shareResolver.ts:89': 'share:token: key built three lines above; options are file constants used nowhere else',
  'pages/api/accounting/annotations/index.ts:60': 'annotationRateLimitKey builds a per-action, per-user name; default options',
  'pages/api/accounting/annotations/index.ts:82': 'annotationRateLimitKey builds a per-action, per-user name; default options',
  'pages/api/accounting/annotations/[id]/resolve.ts:26': 'annotationRateLimitKey builds a per-action, per-user name; default options',
};

interface Site { where: string; prefix: string; options: string }
interface Census { sites: Site[]; unreadable: string[] }

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

/** `{ max: 5, windowSecs: 15 * 60 }` -> `max=5;windowSecs=900`. Null when a value is not a number. */
function readOptions(literal: string | undefined, source: string, ignore: string[] = []): string | null {
  if (literal === undefined) return '';
  if (!/^\{[\s\S]*\}$/.test(literal)) return null;
  const pairs: string[] = [];
  for (const part of literal.slice(1, -1).split(',')) {
    if (part.trim() === '') continue;
    const m = /^\s*(\w+)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (!m) return null;
    if (ignore.includes(m[1]!)) continue;
    // A named constant counts only if this file defines it as a plain number.
    const expr = m[2]!.replace(/\b[A-Z][A-Z0-9_]*\b/g, (name) =>
      new RegExp(`const ${name} = ([0-9_]+);`).exec(source)?.[1] ?? name).replace(/_/g, '');
    if (!/^[0-9*\s]+$/.test(expr)) return null;
    pairs.push(`${m[1]}=${expr.split('*').reduce((product, n) => product * Number(n), 1)}`);
  }
  return pairs.sort().join(';');
}

/** The part of a key literal before its first interpolation. Null when the key is not a literal. */
function staticPrefix(arg: string | undefined): string | null {
  const m = /^([`'"])([\s\S]*)\1$/.exec(arg ?? '');
  if (!m) return null;
  const prefix = m[1] === '`' ? m[2]!.split('${')[0]! : m[2]!;
  return prefix === '' ? null : prefix;
}

function census(files: Record<string, string>): Census {
  const out: Census = { sites: [], unreadable: [] };
  for (const [file, raw] of Object.entries(files)) {
    // Drop line comments (they carry commas and slashes) but keep every newline.
    const source = raw.replace(/(^|[ \t])\/\/.*$/gm, '');
    for (const match of source.matchAll(CALL)) {
      const where = `${file}:${source.slice(0, match.index).split('\n').length}`;
      const fn = match[1]!;
      const args = splitArgs(source.slice(match.index! + match[0].length));
      let prefix: string | null = null;
      let options: string | null = null;
      if (args && fn === 'checkRateLimit') {
        prefix = staticPrefix(args[0]);
        options = readOptions(args[1], source, ['cost']);
      } else if (args && fn === 'withRateLimit') {
        const scope = staticPrefix(args[2]);
        prefix = scope && `${scope}:ip:`;
        options = readOptions(args[1], source);
      } else if (args) {
        const [name, opts] = fn === 'checkReportRateLimit' ? [args[1], args[2]] : [args[2], args[3]];
        const literal = staticPrefix(name);
        prefix = literal && `${fn.replace(/^check|RateLimit$/g, '').toLowerCase()}:${literal}:`;
        options = readOptions(opts, source, ['count']);
      }
      if (prefix === null || options === null || options === '' && fn === 'checkRateLimit') out.unreadable.push(where);
      else out.sites.push({ where, prefix, options });
    }
  }
  return out;
}

/** Prefixes used with more than one set of options. */
function collisions(sites: Site[]): string[] {
  const byPrefix = new Map<string, Site[]>();
  for (const site of sites) byPrefix.set(site.prefix, [...(byPrefix.get(site.prefix) ?? []), site]);
  return [...byPrefix.entries()]
    .filter(([, group]) => new Set(group.map((s) => s.options)).size > 1)
    .map(([prefix, group]) => `${prefix} -> ${group.map((s) => `${s.where} {${s.options}}`).join(' vs ')}`);
}

function trackedSources(): Record<string, string> {
  const listed = execFileSync('git', ['ls-files', '--', 'pages', 'src'], { cwd: ROOT, encoding: 'utf8' });
  const files: Record<string, string> = {};
  for (const file of listed.split('\n')) {
    // The limiter's own file defines these functions and composes its own keys.
    if (!/\.tsx?$/.test(file) || file === 'src/lib/rateLimit.ts') continue;
    files[file] = readFileSync(path.join(ROOT, file), 'utf8');
  }
  return files;
}

describe('rate-limit key census (R-175)', () => {
  const found = census(trackedSources());

  it('finds the call sites', () => {
    expect(found.sites.length).toBeGreaterThan(60);
    expect(found.sites.map((s) => s.prefix)).toEqual(expect.arrayContaining([
      'portal-auth:', 'afs-portal-magic-link:', 'login:ip:', 'login:email:', 'ai:nl-query:', 'send:invoice-email:', 'report:reports-pdf:',
    ]));
  });

  it('no two call sites share a key prefix with different options', () => {
    expect(collisions(found.sites)).toEqual([]);
  });

  it('every call it cannot read is pinned, and every pin still points at such a call', () => {
    expect([...found.unreadable].sort()).toEqual(Object.keys(PINNED).sort());
  });

  it('the detector goes red on the collision it was written for', () => {
    const synthetic = census({
      'a.ts': "await checkRateLimit(`portal-auth:${ip}`, { max: 5, windowSecs: 15 * 60 });",
      'b.ts': "const allowed = await checkRateLimit(`portal-auth:${ip}`, { max: 5, windowSecs: 60 });",
      'c.ts': "export default withRateLimit(withUserAuth(withCsrf(handler)), { max: 10, windowSecs: 900 }, 'x');\n"
        + "const W = 900;\nawait checkRateLimit(`x:ip:${getClientIp(req)}`, {\n  max: 10, // per IP\n  windowSecs: W,\n});",
      'd.ts': "await checkAiRateLimit(req, companyId, 'n', { dailyMax: 300 });\nawait checkAiRateLimit(req, companyId, 'n');",
      'e.ts': 'await checkRateLimit(key, { max: 1, windowSecs: 1 });\nawait checkRateLimit(`k:${a}`, opts);',
    });

    expect(collisions(synthetic.sites)).toEqual([
      'portal-auth: -> a.ts:1 {max=5;windowSecs=900} vs b.ts:1 {max=5;windowSecs=60}',
      'ai:n: -> d.ts:1 {dailyMax=300} vs d.ts:2 {}',
    ]);
    expect(synthetic.sites.filter((s) => s.prefix === 'x:ip:').map((s) => s.options)).toEqual(['max=10;windowSecs=900', 'max=10;windowSecs=900']);
    expect(synthetic.unreadable).toEqual(['e.ts:1', 'e.ts:2']);
  });
});
