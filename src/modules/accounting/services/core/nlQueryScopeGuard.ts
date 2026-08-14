/**
 * NL Query Tenant-Scope Guard
 *
 * Defence against cross-tenant data leakage from LLM-generated SQL. The original
 * check was a substring regex asserting `company_id = '<id>'` appeared *somewhere*
 * in the query — bypassable with an OR branch
 * (`WHERE company_id = 'own' OR company_id <> 'own'`) or a cross-join to an
 * unscoped alias (`FROM customers c1 JOIN customers c2 ON 1=1`).
 *
 * This guard parses the SQL to an AST and enforces, for EVERY select node
 * (top-level, subqueries, CTE bodies) independently:
 *   1. No OR operator anywhere in a WHERE clause or JOIN ON condition — so a
 *      scope predicate can never be disjoined away, and the remaining boolean
 *      tree is a pure conjunction we can flatten.
 *   2. A "seed" exists: some alias carries an AND-ed equality
 *      `alias.company_id = '<callerCompanyId>'` matching the caller's own id
 *      exactly. (A predicate on a non-existent column errors at execution, so
 *      seed detection by predicate presence is safe.)
 *   3. Every base table referenced by that select is reachable from a seed via
 *      the join graph — where an edge is added ONLY for a predicate `A.x = B.y`
 *      that matches a real foreign-key→primary-key relationship (see FK_PAIRS).
 *      Referential integrity to a company-scoped row keeps the join in-tenant;
 *      an arbitrary equijoin on a shared-value column (`is_active`, `name`,
 *      `total_amount`) is NOT an FK, builds no edge, and is rejected.
 *
 * Fails closed: any parse error or AST shape we cannot analyse is rejected.
 * Conservative by design — it may reject some benign queries (degrading the AI
 * feature to "please rephrase"), which is the correct trade-off for a
 * cross-tenant financial-data boundary.
 *
 * FK_PAIRS is generated from the live schema (see the SQL in the PR); regenerate
 * when foreign keys among the NL-query allowlisted tables change. Tables/edges
 * absent here are simply unreachable → their queries are rejected, never leaked.
 */
import { parse, type Statement } from 'pgsql-ast-parser';

export interface ScopeResult {
  ok: boolean;
  reason?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/**
 * Verified FK→PK column pairs among the NL-query allowlisted tables, each stored
 * as a lexicographically-sorted `tableA.colA|tableB.colB` string so lookup is
 * orientation-independent. Only pairs whose parent column is the primary key.
 */
const FK_PAIRS = new Set<string>([
  'accounting_budgets.gl_account_id|gl_accounts.id',
  'asset_categories.gl_asset_account_id|gl_accounts.id',
  'asset_categories.gl_depreciation_account_id|gl_accounts.id',
  'asset_categories.gl_expense_account_id|gl_accounts.id',
  'asset_categories.id|assets.category_id',
  'asset_depreciation_schedule.asset_id|assets.id',
  'asset_depreciation_schedule.journal_entry_id|gl_journal_entries.id',
  'asset_disposals.asset_id|assets.id',
  'asset_disposals.journal_entry_id|gl_journal_entries.id',
  'assets.gl_asset_account_id|gl_accounts.id',
  'assets.gl_depreciation_account_id|gl_accounts.id',
  'assets.gl_expense_account_id|gl_accounts.id',
  'bank_accounts.gl_account_id|gl_accounts.id',
  'bank_categorisation_rules.company_id|gl_accounts.id',
  'bank_categorisation_rules.company_id|suppliers.id',
  'bank_categorisation_rules.gl_account_id|gl_accounts.id',
  'bank_categorisation_rules.supplier_id|suppliers.id',
  'bank_reconciliations.bank_account_id|gl_accounts.id',
  'bank_reconciliations.id|bank_transactions.reconciliation_id',
  'bank_transactions.bank_account_id|gl_accounts.id',
  'bank_transactions.matched_journal_line_id|gl_journal_lines.id',
  'bank_transactions.predicted_supplier_id|suppliers.id',
  'bank_transactions.provisional_je_id|gl_journal_entries.id',
  'captured_documents.id|customer_invoices.source_document_id',
  'captured_documents.id|dunning_sends.source_document_id',
  'captured_documents.id|gl_journal_entries.source_document_id',
  'captured_documents.id|supplier_invoices.source_document_id',
  'cost_centres.id|cost_centres.parent_id',
  'credit_notes.client_id|customers.id',
  'credit_notes.customer_invoice_id|customer_invoices.id',
  'credit_notes.gl_journal_entry_id|gl_journal_entries.id',
  'credit_notes.supplier_id|suppliers.id',
  'credit_notes.supplier_invoice_id|supplier_invoices.id',
  'customer_invoice_items.invoice_id|customer_invoices.id',
  'customer_invoice_items.time_entry_id|time_entries.id',
  'customer_invoices.customer_id|customers.id',
  'customer_invoices.id|customer_payment_allocations.invoice_id',
  'customer_invoices.id|customer_quotes.converted_invoice_id',
  'customer_invoices.id|customer_sales_orders.invoice_id',
  'customer_invoices.id|customer_write_offs.invoice_id',
  'customer_invoices.id|dunning_sends.customer_invoice_id',
  'customer_payment_allocations.payment_id|customer_payments.id',
  'customer_payments.bank_account_id|gl_accounts.id',
  'customer_payments.client_id|customers.id',
  'customer_payments.gl_journal_entry_id|gl_journal_entries.id',
  'customer_quote_lines.quote_id|customer_quotes.id',
  'customer_quotes.client_id|customers.id',
  'customer_sales_order_items.sales_order_id|customer_sales_orders.id',
  'customer_sales_orders.customer_id|customers.id',
  'customer_write_offs.client_id|customers.id',
  'customer_write_offs.gl_journal_entry_id|gl_journal_entries.id',
  'customers.id|projects.client_id',
  'customers.id|recurring_invoices.client_id',
  'dunning_sends.template_id|dunning_templates.id',
  'fiscal_periods.id|gl_account_balances.fiscal_period_id',
  'fiscal_periods.id|gl_journal_entries.fiscal_period_id',
  'gl_account_balances.gl_account_id|gl_accounts.id',
  'gl_accounts.id|gl_accounts.parent_account_id',
  'gl_accounts.id|gl_journal_lines.gl_account_id',
  'gl_accounts.id|product_categories.gl_cogs_account_id',
  'gl_accounts.id|product_categories.gl_inventory_account_id',
  'gl_accounts.id|product_categories.gl_revenue_account_id',
  'gl_accounts.id|products.gl_cogs_account_id',
  'gl_accounts.id|products.gl_inventory_account_id',
  'gl_accounts.id|products.gl_revenue_account_id',
  'gl_accounts.id|supplier_invoice_items.gl_account_id',
  'gl_accounts.id|supplier_payment_batches.bank_account_id',
  'gl_accounts.id|supplier_payments.bank_account_id',
  'gl_journal_entries.id|gl_journal_entries.reversal_of_id',
  'gl_journal_entries.id|gl_journal_lines.journal_entry_id',
  'gl_journal_entries.id|stock_adjustments.journal_entry_id',
  'gl_journal_entries.id|supplier_invoices.gl_journal_entry_id',
  'gl_journal_entries.id|supplier_payment_batches.gl_journal_entry_id',
  'gl_journal_entries.id|supplier_payments.gl_journal_entry_id',
  'gl_journal_entries.id|vat_adjustments.gl_journal_entry_id',
  'gl_journal_entries.id|vat_returns.journal_entry_id',
  'leave_applications.leave_type_id|leave_types.id',
  'leave_balances.leave_type_id|leave_types.id',
  'product_categories.id|product_categories.parent_id',
  'product_categories.id|products.category_id',
  'products.id|stock_adjustments.product_id',
  'project_time_entries.project_id|projects.id',
  'purchase_orders.supplier_id|suppliers.id',
  'supplier_invoice_items.supplier_invoice_id|supplier_invoices.id',
  'supplier_invoices.id|supplier_payment_allocations.invoice_id',
  'supplier_invoices.supplier_id|suppliers.id',
  'supplier_payment_allocations.payment_id|supplier_payments.id',
  'supplier_payments.supplier_id|suppliers.id',
  'supplier_purchase_order_items.purchase_order_id|supplier_purchase_orders.id',
  'supplier_purchase_orders.supplier_id|suppliers.id',
]);

const fail = (reason: string): ScopeResult => ({ ok: false, reason });

function isFkEdge(tableA: string, colA: string, tableB: string, colB: string): boolean {
  const a = `${tableA}.${colA}`;
  const b = `${tableB}.${colB}`;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  return FK_PAIRS.has(key);
}

/** Unwrap a value expression through casts to reach an underlying string literal. */
function stringLiteralValue(expr: Node): string | null {
  let e = expr;
  while (e && e.type === 'cast') e = e.operand;
  if (e && e.type === 'string' && typeof e.value === 'string') return e.value;
  return null;
}

/** A column reference like `alias.col`, or unqualified `col`. */
function columnRef(expr: Node): { table: string | null; column: string } | null {
  if (expr && expr.type === 'ref' && typeof expr.name === 'string') {
    return { table: expr.table?.name ? String(expr.table.name).toLowerCase() : null, column: expr.name.toLowerCase() };
  }
  return null;
}

/** True if an OR operator appears anywhere in the node tree. */
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

/** Flatten an AND-tree into conjuncts. Returns false if any OR is present. */
function flattenConjuncts(expr: Node, out: Node[]): boolean {
  if (!expr) return true;
  if (expr.type === 'binary' && expr.op === 'OR') return false;
  if (expr.type === 'binary' && expr.op === 'AND') {
    return flattenConjuncts(expr.left, out) && flattenConjuncts(expr.right, out);
  }
  if (containsOr(expr)) return false;
  out.push(expr);
  return true;
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
  if (!from || !Array.isArray(from)) return { ok: true }; // e.g. SELECT 1 — no table

  // alias -> real table name, for base tables only. Derived tables / functions /
  // CTE refs are validated elsewhere (their inner selects are walked) and are
  // treated as safe sources here.
  const aliasTable = new Map<string, string>();
  for (const entry of from) {
    if (!entry || typeof entry !== 'object') return fail('unrecognised FROM entry');
    if (entry.type !== 'table') continue;
    const tableName = String(entry.name?.name ?? '').toLowerCase();
    const alias = String(entry.name?.alias ?? tableName).toLowerCase();
    if (cteNames.has(tableName)) continue; // CTE ref — validated in its body
    if (!tableName) return fail('unnamed table');
    aliasTable.set(alias, tableName);
  }
  if (aliasTable.size === 0) return { ok: true };

  // Only INNER joins are sound: an outer join (LEFT/RIGHT/FULL) preserves the
  // rows of one side regardless of the ON predicate, so a seed or FK edge in the
  // ON does not actually filter the preserved side to the tenant. A CROSS join
  // has no ON at all. Reject anything that is not a plain INNER JOIN.
  for (const entry of from) {
    const jt = entry?.join?.type;
    if (jt && jt !== 'INNER JOIN') {
      return fail(`join type '${jt}' is not permitted`);
    }
  }

  // All boolean conditions: WHERE + every INNER JOIN ON. Any OR => reject.
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

  const onlyAlias = aliasTable.size === 1 ? [...aliasTable.keys()][0]! : null;
  const seeds = new Set<string>();
  const edges = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a)!.add(b);
    edges.get(b)!.add(a);
  };

  for (const c of conjuncts) {
    if (!c || c.type !== 'binary' || c.op !== '=') continue;
    const left = columnRef(c.left);
    const right = columnRef(c.right);

    // Seed: company_id = '<callerId>'
    if (left && left.column === 'company_id' && stringLiteralValue(c.right) === companyId) {
      const a = left.table ?? onlyAlias;
      if (a && aliasTable.has(a)) seeds.add(a);
    }
    if (right && right.column === 'company_id' && stringLiteralValue(c.left) === companyId) {
      const a = right.table ?? onlyAlias;
      if (a && aliasTable.has(a)) seeds.add(a);
    }

    // FK edge: both sides qualified, and the (table,col) pair is a real FK→PK.
    if (left && right && left.table && right.table) {
      const tl = aliasTable.get(left.table);
      const tr = aliasTable.get(right.table);
      if (tl && tr && isFkEdge(tl, left.column, tr, right.column)) {
        addEdge(left.table, right.table);
      }
    }
  }

  if (seeds.size === 0) return fail('no company_id scope bound to the caller company');

  // Reachability from seeds over FK edges.
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

  for (const alias of aliasTable.keys()) {
    if (!reached.has(alias)) return fail(`table alias '${alias}' is not tenant-scoped`);
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
