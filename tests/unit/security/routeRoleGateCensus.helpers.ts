/**
 * Detector for mutatingRouteRoleGateCensus.test.ts — reads a route file's TEXT, so it has named limits:
 * a method literal assembled at runtime, or a gate applied inside the handler, is invisible to it.
 * Those routes are listed by hand in the census's EXEMPT, with the reason.
 */
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

export function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name) ? [p] : [];
  });
}

/** Source with comments removed, so a gate named in a doc comment does not count. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
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

/** A route is GET-only when it refuses every other method and names no write method anywhere. */
export function isMutating(src: string): boolean {
  const code = stripComments(src);
  return WRITE_LITERAL.test(code) || !GET_ONLY_GUARD.test(code);
}

const WRITE_ROLES = new Set(['owner', 'admin', 'manager']);

/** withWriteAccess with no options, or allowedRoles naming only writing roles. */
function writeAccessGates(expr: string): boolean {
  const calls = expr.match(/withWriteAccess\(/g)?.length ?? 0;
  if (calls === 0) return false;
  const opts = [...expr.matchAll(/allowedRoles\s*:\s*(null|\[[^\]]*\]|[A-Za-z_$][\w$.]*)/g)].map((m) => m[1]!);
  return opts.every((o) => {
    if (!o.startsWith('[')) return o === 'DEFAULT_WRITE_ROLES';
    const roles = [...o.matchAll(/['"]([a-z_]+)['"]/g)].map((r) => r[1]!);
    return roles.length > 0 && roles.every((r) => WRITE_ROLES.has(r));
  });
}

/** The default export composes a gate that refuses a non-writing role. */
export function isGated(expr: string): boolean {
  return writeAccessGates(expr)
    || /withRole\(\s*['"](manager|admin|owner)['"]\s*\)/.test(expr)
    || /withPayrollDetailAccess\(|withPlatformAdmin\(/.test(expr);
}

/** Entry points with their own non-company authentication (admin host, user session, portals, tokens). */
export const OTHER_AUTH_WRAPPER = /^(withAdmin|withUserAuth|withPortalAuth|withExtensionToken)\(|withInviteToken\(/;
