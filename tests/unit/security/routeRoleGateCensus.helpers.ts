/**
 * Detector for mutatingRouteRoleGateCensus.test.ts — reads a route file's TEXT, so it has named limits:
 * a method literal assembled at runtime, or a gate applied inside the handler, is invisible to it.
 * Those routes are listed by hand in the census's EXEMPT, with the reason. withWriteAccess passes every
 * GET, so a gated route that writes from its GET branch counts as gated, as does a gate applied on the
 * wrong branch of a conditional; and an inline exemption's role call is matched as text, not as reached
 * on the write path. A gate is also matched wherever it appears in the file's text, so a gate passed as a
 * stray argument, inside a comma expression or wrapped in another call counts as gated. All beyond a text
 * census.
 */
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { WITH_ROLE_ADMITS } from '@/lib/auth/withRole';

export function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name) ? [p] : [];
  });
}

/**
 * Source with comments removed, so a gate named in a doc comment does not count. String-aware: a `//`
 * inside a quoted string or a template literal (a URL, `'a//b'`) is text, not a comment. A ' or " string
 * ends at a newline, so an apostrophe in a regex literal (`/don't/`) cannot hold one open past its line.
 */
export function stripComments(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i++; } else if (c === quote || (c === '\n' && quote !== '`')) quote = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
  }
  return out;
}

/** The expression starting at `from`, up to the first `;` or newline at bracket depth 0. */
function expressionAt(code: string, from: number): string {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && (c === ';' || c === '\n')) return code.slice(from, i);
  }
  return code.slice(from);
}

/**
 * The default export's expression. `export default x` resolves x's `const x = …` initializer (one level),
 * so moving the wrapper chain into a variable does not hide it. A function declaration is returned as
 * `function`: a hand-written entry point the census cannot see into.
 */
export function defaultExport(src: string): string {
  const code = stripComments(src);
  const m = /^export default /m.exec(code);
  if (!m) return '';
  const expr = expressionAt(code, m.index + m[0].length).trim();
  if (/^(async\s+)?function\b/.test(expr)) return 'function';
  const id = /^([A-Za-z_$][\w$]*)$/.exec(expr)?.[1];
  if (!id) return expr;
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*(?::[^=]+)?=\\s*`).exec(code);
  if (decl) return expressionAt(code, decl.index + decl[0].length).trim();
  return /\b(?:async\s+)?function\s+/.test(code) && new RegExp(`function\\s+${id}\\b`).test(code) ? 'function' : expr;
}

const WRITE_LITERAL = /['"`](POST|PUT|PATCH|DELETE)['"`]/;
/** A guard that refuses every method but GET: `req.method !== 'GET'`, or a 405 listing GET alone. */
const GET_ONLY_GUARD = /req\.method\s*!==?\s*['"]GET['"]|methodNotAllowed\([^)]*\[\s*['"]GET['"]\s*\]\s*\)/;

/** Inline SQL that writes. A GET handler can write too, and withWriteAccess lets every GET through. */
const WRITE_SQL = /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+["\w.]+\s+SET)\b/i;

/**
 * A route is GET-only when it refuses every other method, names no write method and writes no inline
 * SQL. A write reached through a service from a GET is beyond a text census.
 */
export function isMutating(src: string): boolean {
  const code = stripComments(src);
  return WRITE_LITERAL.test(code) || WRITE_SQL.test(code) || !GET_ONLY_GUARD.test(code);
}

const WRITE_ROLES = new Set(['owner', 'admin', 'manager']);

/** The arguments of the call whose `(` is at `open`, split at depth-0 commas. */
function callArgs(expr: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < expr.length; i++) {
    const c = expr[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { depth--; if (depth === 0) { args.push(expr.slice(start, i)); break; } }
    else if (c === ',' && depth === 1) { args.push(expr.slice(start, i)); start = i + 1; }
  }
  return args.map((a) => a.trim()).filter(Boolean);
}

/**
 * Every withWriteAccess call takes the handler alone, or an object LITERAL whose allowedRoles names only
 * writing roles. Options from a variable or a spread cannot be read, so they do not count as a gate.
 */
function writeAccessGates(expr: string): boolean {
  const calls = [...expr.matchAll(/withWriteAccess\(/g)];
  if (calls.length === 0) return false;
  return calls.every((m) => {
    const [, opts] = callArgs(expr, m.index! + m[0].length - 1);
    if (opts === undefined) return true;
    if (!/^\{[\s\S]*\}$/.test(opts) || opts.includes('...')) return false;
    if (!/allowedRoles/.test(opts)) return true;
    // Only `allowedRoles: DEFAULT_WRITE_ROLES` or an array of quoted role names, followed by `,` or `}`:
    // a `.concat(…)`, an identifier element or a spread inside the array is unreadable, so not a gate.
    const roles = /allowedRoles\s*:\s*(\[[^\]]*\]|DEFAULT_WRITE_ROLES)\s*[,}]/.exec(opts)?.[1];
    if (!roles) return false;
    if (roles === 'DEFAULT_WRITE_ROLES') return true;
    const elements = roles.slice(1, -1).split(',').map((e) => e.trim()).filter(Boolean);
    return elements.length > 0 && elements.every((e) => {
      const name = /^['"]([a-z_]+)['"]$/.exec(e)?.[1];
      return name !== undefined && WRITE_ROLES.has(name);
    });
  });
}

/** withRole at a level whose allow-list names only writing roles (today: admin). */
const WITH_ROLE_GATE = new RegExp(`withRole\\(\\s*['"](${Object.entries(WITH_ROLE_ADMITS)
  .filter(([, roles]) => roles.every((r) => WRITE_ROLES.has(r))).map(([level]) => level).join('|')})['"]\\s*\\)`);

/** The default export composes a gate that refuses a non-writing role. */
export function isGated(expr: string): boolean {
  return writeAccessGates(expr)
    || WITH_ROLE_GATE.test(expr)
    || /withPayrollDetailAccess\(|withPlatformAdmin\(/.test(expr);
}

/** Entry points with their own non-company authentication (admin host, user session, portals, tokens). */
export const OTHER_AUTH_WRAPPER = /^(withAdmin|withUserAuth|withPortalAuth|withExtensionToken)\(|withInviteToken\(/;
