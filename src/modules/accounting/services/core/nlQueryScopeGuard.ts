/**
 * NL Query Tenant-Scope Guard
 *
 * Defence against cross-tenant data leakage from LLM-generated SQL. The prior
 * check was a substring regex asserting `company_id = '<id>'` appeared *somewhere*
 * in the query — trivially bypassable with an OR branch
 * (`WHERE company_id = 'own' OR company_id <> 'own'`) or a cross-join to an
 * unscoped alias (`FROM customers c1 JOIN customers c2 ON 1=1`).
 *
 * This guard parses the SQL to an AST and enforces, for EVERY select node
 * (top-level, subqueries, and CTE bodies) independently:
 *   1. No OR operator anywhere in a WHERE clause or JOIN ON condition — so a
 *      scope predicate can never be disjoined away, and the remaining boolean
 *      tree is a pure conjunction we can flatten.
 *   2. A "seed" exists: some table/alias carries an AND-ed equality
 *      `alias.company_id = '<callerCompanyId>'` (matching the caller's own id
 *      exactly — not a hardcoded foreign id).
 *   3. Every base table referenced by that select is reachable from a seed via
 *      the equijoin graph built from AND-ed `A.col = B.col` predicates. This
 *      rejects cross-joins / bogus joins to unscoped aliases while allowing
 *      legitimate parent→child joins.
 *
 * Fails closed: any parse error or AST shape we cannot analyse is rejected.
 * Conservative by design — it may reject some benign queries (degrading the AI
 * feature to "please rephrase"), which is the correct trade-off for a
 * cross-tenant financial-data boundary.
 */
import { parse, type Statement } from 'pgsql-ast-parser';

export interface ScopeResult {
  ok: boolean;
  reason?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const fail = (reason: string): ScopeResult => ({ ok: false, reason });

/** Unwrap a value expression through casts to reach an underlying string literal. */
function stringLiteralValue(expr: Node): string | null {
  let e = expr;
  while (e && e.type === 'cast') e = e.operand;
  if (e && e.type === 'string' && typeof e.value === 'string') return e.value;
  return null;
}

/** A qualified column reference like `alias.company_id`, or unqualified `company_id`. */
function columnRef(expr: Node): { table: string | null; column: string } | null {
  if (expr && expr.type === 'ref' && typeof expr.name === 'string') {
    return { table: expr.table?.name ?? null, column: expr.name };
  }
  return null;
}

/**
 * Flatten an AND-tree into its conjuncts. Returns null if any OR is encountered
 * anywhere in the tree (fail-closed signal).
 */
function flattenConjuncts(expr: Node, out: Node[]): boolean {
  if (!expr) return true;
  if (expr.type === 'binary' && expr.op === 'OR') return false;
  if (expr.type === 'binary' && expr.op === 'AND') {
    return flattenConjuncts(expr.left, out) && flattenConjuncts(expr.right, out);
  }
  // Guard against OR nested inside other expression shapes (e.g. NOT (a OR b)).
  if (containsOr(expr)) return false;
  out.push(expr);
  return true;
}

function containsOr(node: Node): boolean {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'binary' && node.op === 'OR') return true;
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) {
      if (v.some((x) => containsOr(x))) return true;
    } else if (v && typeof v === 'object') {
      if (containsOr(v)) return true;
    }
  }
  return false;
}

/** Collect every object with `type === 'select'` anywhere in the AST. */
function collectSelects(node: Node, out: Node[]): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'select') out.push(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((x) => collectSelects(x, out));
    else if (v && typeof v === 'object') collectSelects(v, out);
  }
}

/** Collect CTE alias names defined by any WITH node; these are safe FROM sources. */
function collectCteNames(node: Node, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'with' && Array.isArray(node.bind)) {
    for (const b of node.bind) {
      const name = b?.alias?.name;
      if (typeof name === 'string') out.add(name.toLowerCase());
    }
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((x) => collectCteNames(x, out));
    else if (v && typeof v === 'object') collectCteNames(v, out);
  }
}

/** Validate a single select node's tenant scoping. */
function validateSelect(sel: Node, companyId: string, cteNames: Set<string>): ScopeResult {
  const from = sel.from;
  if (!from || !Array.isArray(from)) return { ok: true }; // e.g. SELECT 1 — no table, nothing to scope

  // Base tables (aliases) that require scoping. Subquery/derived-table FROM
  // entries are validated as their own select node elsewhere, so they are safe
  // sources here; CTE references are validated in their WITH body.
  const requiredAliases = new Set<string>();
  const singleTableAliases: string[] = [];
  for (const entry of from) {
    if (!entry || typeof entry !== 'object') return fail('unrecognised FROM entry');
    if (entry.type !== 'table') {
      // derived table / function / values — its internals are validated via the
      // global select walk; do not require reachability for its alias.
      continue;
    }
    const tableName: string = entry.name?.name ?? '';
    const alias: string = (entry.name?.alias ?? tableName).toLowerCase();
    if (cteNames.has(tableName.toLowerCase())) continue; // CTE ref — already validated
    requiredAliases.add(alias);
    singleTableAliases.push(alias);
  }
  if (requiredAliases.size === 0) return { ok: true };

  // Gather all boolean conditions: the WHERE plus every JOIN ON. Any OR => reject.
  const conjuncts: Node[] = [];
  if (sel.where && !flattenConjuncts(sel.where, conjuncts)) {
    return fail('OR in WHERE clause is not permitted');
  }
  for (const entry of from) {
    const on = entry?.join?.on;
    if (on && !flattenConjuncts(on, conjuncts)) {
      return fail('OR in JOIN ON is not permitted');
    }
  }

  // Seeds: aliases with an AND-ed `alias.company_id = '<companyId>'` predicate.
  const seeds = new Set<string>();
  const edges = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a)!.add(b);
    edges.get(b)!.add(a);
  };

  const onlyAlias = requiredAliases.size === 1 ? singleTableAliases[0]! : null;

  for (const c of conjuncts) {
    if (!c || c.type !== 'binary' || c.op !== '=') continue;
    const left = columnRef(c.left);
    const right = columnRef(c.right);

    // Scope seed: company_id = '<callerId>'
    if (left && left.column.toLowerCase() === 'company_id') {
      const val = stringLiteralValue(c.right);
      if (val === companyId) {
        const a = left.table ? left.table.toLowerCase() : onlyAlias;
        if (a) seeds.add(a);
      }
    }
    if (right && right.column.toLowerCase() === 'company_id') {
      const val = stringLiteralValue(c.left);
      if (val === companyId) {
        const a = right.table ? right.table.toLowerCase() : onlyAlias;
        if (a) seeds.add(a);
      }
    }

    // Equijoin edge: A.col = B.col (both qualified column refs)
    if (left && right && left.table && right.table) {
      addEdge(left.table.toLowerCase(), right.table.toLowerCase());
    }
  }

  if (seeds.size === 0) return fail('no company_id scope bound to the caller company');

  // Reachability: every required alias must connect to some seed via equijoins.
  const reached = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of edges.get(cur) ?? []) {
      if (!reached.has(nb)) {
        reached.add(nb);
        queue.push(nb);
      }
    }
  }

  for (const alias of requiredAliases) {
    if (!reached.has(alias)) {
      return fail(`table alias '${alias}' is not tenant-scoped`);
    }
  }
  return { ok: true };
}

/**
 * Enforce that `sql` can only read the caller's own tenant data.
 * Returns { ok: true } only if every select node is provably tenant-scoped.
 */
export function enforceTenantScope(sql: string, companyId: string): ScopeResult {
  if (!companyId) return fail('missing company id');

  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch {
    return fail('unparseable SQL');
  }
  if (statements.length !== 1) return fail('exactly one statement is required');

  const top = statements[0] as Node;
  if (top.type !== 'select' && top.type !== 'with') {
    return fail('only SELECT / WITH queries are permitted');
  }

  const cteNames = new Set<string>();
  collectCteNames(top, cteNames);

  const selects: Node[] = [];
  collectSelects(top, selects);
  if (selects.length === 0) return fail('no SELECT found');

  for (const sel of selects) {
    const result = validateSelect(sel, companyId, cteNames);
    if (!result.ok) return result;
  }
  return { ok: true };
}
