/**
 * A tiny in-memory `gl_accounts` for unit tests that mock the `sql` tag.
 *
 * It does not parse SQL. It reads which filters the query TEXT carries
 * (`company_id =`, `id = ANY(`, `account_code = ANY(`, `account_subtype =`,
 * `id =`) and applies each to the VALUE bound at that placeholder. A query that
 * drops a filter therefore returns the unfiltered rows (the other company's
 * accounts are in the table on purpose), and a wrong value filters the wrong
 * rows: either way the test sees it. Also answers the header-account guard's
 * two queries (headerAccountGuard) from `level` and `parent_account_id`.
 */
export interface GlAccountRow {
  id: string;
  company_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  account_subtype: string | null;
  is_system_account: boolean;
  is_active: boolean;
  level: number;
  parent_account_id: string | null;
  created_at: Date;
}

export const glAccount = (over: Partial<GlAccountRow> & Pick<GlAccountRow, 'id' | 'company_id' | 'account_code'>): GlAccountRow => ({
  account_name: `Account ${over.account_code}`,
  account_type: 'asset',
  account_subtype: null,
  is_system_account: false,
  is_active: true,
  level: 3,
  parent_account_id: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

/** The value bound at the placeholder the first `re` match of the query text ends on, or undefined if the text has no such clause. */
function bound(text: string, values: unknown[], re: RegExp): { value: unknown } | null {
  const m = re.exec(text);
  if (!m) return null;
  const index = (text.slice(0, m.index + m[0].length).match(/\?/g) ?? []).length - 1;
  return { value: values[index] };
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Rows `gl_accounts` returns for this query (the whole table filtered by the clauses the text carries). */
export function selectGlAccounts(table: GlAccountRow[], strings: TemplateStringsArray, values: unknown[]): GlAccountRow[] {
  const text = strings.join('?');
  let rows = table;
  const company = bound(text, values, /company_id\s*=\s*\?/);
  if (company) rows = rows.filter((r) => r.company_id === String(company.value));
  const ids = bound(text, values, /\bid\s*=\s*ANY\(\?/);
  if (ids) rows = rows.filter((r) => asList(ids.value).includes(r.id));
  const one = bound(text, values, /\bid\s*=\s*\?/);
  if (one && !ids) rows = rows.filter((r) => r.id === String(one.value));
  const codes = bound(text, values, /account_code\s*=\s*ANY\(\?/);
  if (codes) rows = rows.filter((r) => asList(codes.value).includes(r.account_code));
  const subtype = bound(text, values, /account_subtype\s*=\s*\?/);
  if (subtype) rows = rows.filter((r) => r.account_subtype === String(subtype.value));
  return rows;
}

/** headerAccountGuard's lock query (FOR KEY SHARE) and its header query, answered from the table. */
export function answerHeaderGuard(table: GlAccountRow[], strings: TemplateStringsArray, values: unknown[]): Array<{ id: string; account_code?: string; account_name?: string }> {
  const text = strings.join('?');
  const rows = selectGlAccounts(table, strings, values);
  const hasChild = (r: GlAccountRow) => table.some((c) => c.parent_account_id === r.id && c.company_id === r.company_id);
  if (text.includes('FOR KEY SHARE')) {
    return rows.filter((r) => r.level < 3 || hasChild(r)).map((r) => ({ id: r.id }));
  }
  return rows.filter((r) => r.level < 3 && hasChild(r)).map((r) => ({ id: r.id, account_code: r.account_code, account_name: r.account_name }));
}

export const isGlAccountsQuery = (strings: TemplateStringsArray): boolean => strings.join('?').includes('FROM gl_accounts');
