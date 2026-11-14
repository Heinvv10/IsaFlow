import ts from 'typescript';

/**
 * Why a file that talks to /api/admin breaks the admin-fetch rule. One entry per offence: `line: reason`.
 *
 * AST based, so a header in a comment, a call spelled `apiFetch<T> (`, a URL held in a constant, a template, a
 * `BASE + '/x'`, an alias, `window.fetch`, a `const f = apiFetch` or a spread options object cannot evade it.
 *
 * A file is an ADMIN file when a string/template literal contains `/api/admin` (type positions and comments do not
 * count), when an admin route is BUILT (a `+` chain or template whose static text joins `/api/` and `admin`, puts a
 * `${}` segment right after `/api/` or right before `/admin`), when it mentions the identifier ADMIN_API or IMPORTS a
 * binding named like *ADMIN* (a route constant from an unselected module: a name rule, simpler than resolving
 * constants across files), or when it imports adminFetch. In an admin file:
 *   - it must import adminFetch (when it contains an admin string);
 *   - fetch / window.fetch / globalThis.fetch / self.fetch / apiFetch / apiJson may only be called with a PLAIN
 *     string literal first argument that is not /api/admin (anything else could be an admin URL), except that
 *     apiJson may be called on an admin route when its options are an object literal with a real
 *     `'X-Admin-Request': 'true'` header (it cannot go through adminFetch);
 *   - those names may not be used as values (`const f = apiFetch`, `.then(apiFetch)`);
 *   - adminFetch must not carry a hand-set X-Admin-Request header: it sets it.
 *
 * STATED LIMITS (evasions this does NOT catch): a route joined with `[...].join('/')` or `.concat`; a nested template
 * such as `/api${'/admin'}`; `window[k]` with a variable key; an imported route constant without an uppercase ADMIN
 * in its name (a default or namespace import, `adminRoutes`).
 */
const RAW = new Set(['fetch', 'apiFetch', 'apiJson']);
const ADMIN = '/api/admin';

const text = (n: ts.Node): string | undefined =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined;

function hasAdminHeader(opts: ts.Expression | undefined): boolean | 'hand-set' {
  if (!opts || !ts.isObjectLiteralExpression(opts)) return false;
  for (const p of opts.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name) || p.name.text.toLowerCase() !== 'headers') continue;
    if (!ts.isObjectLiteralExpression(p.initializer)) continue;
    for (const h of p.initializer.properties) {
      if (ts.isPropertyAssignment(h) && (ts.isStringLiteral(h.name) || ts.isIdentifier(h.name)) && h.name.text.toLowerCase() === 'x-admin-request') {
        return text(h.initializer) === 'true' ? 'hand-set' : false;
      }
    }
  }
  return false;
}

/** Static text of a `+` chain or template, each non-literal part as NUL; undefined for any other node. */
function staticText(n: ts.Node): string | undefined {
  if (ts.isParenthesizedExpression(n)) return staticText(n.expression);
  const t = text(n);
  if (t !== undefined) return t;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((sp) => '\0' + sp.literal.text).join('');
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return (staticText(n.left) ?? '\0') + (staticText(n.right) ?? '\0');
  return undefined;
}

/** An admin route assembled from parts: `'/api/' + 'admin/x'`, `/api/${seg}/x`, `${base}/admin/x`. */
function builtRoute(n: ts.Node, asRequestedUrl: boolean): boolean {
  if (!ts.isTemplateExpression(n) && !(ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)) return false;
  const t = staticText(n);
  return t !== undefined && (t.includes(ADMIN) || /\/api\/\0?admin/.test(t) || /\/api\/\0/.test(t) || (asRequestedUrl && /\0\/admin/.test(t)));
}

export function adminFetchViolations(src: string, file = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const at = (n: ts.Node, why: string) => out.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${why}`);

  const alias = new Map<string, string>();   // local name -> raw callee it stands for
  let importsAdmin = false;
  let adminIdent = false;
  const adminNames = new Set<string>(['adminFetch']);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const nb = st.importClause?.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    for (const e of nb.elements) {
      const orig = (e.propertyName ?? e.name).text;
      if (/ADMIN/.test(orig) && orig !== 'ADMIN_REQUEST_HEADER') adminIdent = true;
      if (orig === 'adminFetch') { importsAdmin = true; adminNames.add(e.name.text); }
      else if (RAW.has(orig)) alias.set(e.name.text, orig);
    }
  }

  let adminString = false;
  const visitRefs = (n: ts.Node): void => {
    if (ts.isLiteralTypeNode(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;   // a type-level string or a module path is not a request
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes(ADMIN)) adminString = true;
    if (ts.isIdentifier(n) && n.text === 'ADMIN_API') adminIdent = true;
    if (builtRoute(n, !!n.parent && ts.isCallExpression(n.parent) && n.parent.arguments[0] === n)) adminString = true;
    ts.forEachChild(n, visitRefs);
  };
  visitRefs(sf);
  if (!adminString && !adminIdent && !importsAdmin) return out;
  if ((adminString || adminIdent) && !importsAdmin) at(sf, 'builds or imports what looks like an admin route but does not use adminFetch');

  const rawName = (e: ts.Expression): string | undefined => {
    if (ts.isIdentifier(e)) return alias.get(e.text) ?? (RAW.has(e.text) ? e.text : undefined);
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'fetch' && ts.isIdentifier(e.expression) && /^(window|globalThis|self)$/.test(e.expression.text)) return 'fetch';
    if (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && /^(window|globalThis|self)$/.test(e.expression.text) && text(e.argumentExpression) === 'fetch') return 'fetch';
    return undefined;
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const raw = rawName(n.expression);
      const first = n.arguments[0];
      if (raw) {
        const lit = first && text(first);
        const header = hasAdminHeader(n.arguments[1]);
        const plainNonAdmin = lit !== undefined && !lit.includes(ADMIN);
        if (raw === 'apiJson' && header === 'hand-set') { /* apiJson cannot use adminFetch */ }
        else if (!plainNonAdmin) at(n, `${raw}(...) in an admin file: use adminFetch (or a plain non-admin literal URL)`);
      }
      if (ts.isIdentifier(n.expression) && adminNames.has(n.expression.text)) {
        if (n.arguments.some((a) => hasAdminHeader(a) === 'hand-set')) at(n, 'adminFetch sets X-Admin-Request itself: remove the hand-set header');
      }
    }
    // a raw callee used as a value: `const f = apiFetch`, `.then(apiFetch)`, `{ fetcher: apiFetch }`
    if (ts.isIdentifier(n) && (alias.has(n.text) || RAW.has(n.text)) && n.text !== 'fetch') {
      const p = n.parent;
      const isCallee = ts.isCallExpression(p) && p.expression === n;
      const isDecl = ts.isImportSpecifier(p) || ts.isPropertyAccessExpression(p) && p.name === n;
      if (!isCallee && !isDecl) at(n, `${n.text} used as a value in an admin file`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
