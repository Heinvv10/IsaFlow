/**
 * The reading half of the rate-limit key census (rateLimitKeyCensus.test.ts):
 * finds every limiter call in a set of sources and resolves it to the key
 * pattern and limit it produces. Kept apart from the test for the 300-line cap.
 */
export const NAMES = 'checkRateLimit|chargeRateLimit|checkAiRateLimit|checkSendRateLimit|checkReportRateLimit|withRateLimit|refundRateLimit';
const CALL = new RegExp(`\\b(${NAMES})\\(`, 'g');
/** The limiter's own files: they define these functions and build the wrapper keys. */
export const OWN = ['src/lib/rateLimit.ts', 'src/lib/rateLimitCore.ts', 'src/lib/rateLimitQuota.ts'];
/** The one table of wrapper-applied buckets; its call is resolved from the table itself. */
export const AUTO = 'src/lib/auth/autoRateLimit.ts';

/**
 * checkAiRateLimit / checkSendRateLimit build `<kind>:<name>:co:<company>` (15 minutes) and the same
 * with `:day` (24 hours). The company id is a UUID from the session and holds no colon, so the
 * shorter key can never be the longer one.
 */
const isWrapperDayPair = (a: string, b: string) => /^(ai|send):[^:*]+:co:\*$/.test(a) && b === `${a}:day`;

export interface Site { where: string; pattern: string; options: string }
export interface Census { charges: Site[]; refunds: Site[]; unreadable: string[]; aliased: string[] }

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

export const limit = (max: number, windowSecs: number) => `max=${max};windowSecs=${windowSecs}`;

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

export function census(files: Record<string, string>): Census {
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
export function collisions(sites: Site[]): string[] {
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
export function overlaps(sites: Site[]): string[] {
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

