/**
 * import_budget_workbook's JSON grid (get_budget_template's rows, edited) read into the Excel import's own
 * lines (`ImportLine`), so it is resolved and diffed by exactly the code an uploaded workbook is
 * (`budgetImportDiff.diffImportLines`). The request's SHAPE is refused whole, like a workbook's layout
 * (a row that is not an object, months that are not exactly the year's, a dimension on a company grid, an
 * unknown key); what one row SAYS (an amount that is not a decimal string, an account or member that cannot be
 * budgeted) becomes that row's error in the import's resolver, listed with its reason.
 */
import { UUID_RE } from '@/lib/validation';
import type { ImportLine } from '@/modules/accounting/services/budgets/budgetImportParse';
import type { TemplateGrain } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import type { ParsedCell } from '@/modules/accounting/services/budgets/grid/pasteParse';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { parseMoney } from './budgetToolArgs';

/** Rows one call takes: ~600 bytes each at most (14 months of the widest amount), so ~2.4 MB under the 3 MB MCP body limit. */
export const MAX_GRID_ROWS = 4000;

/** What a row may carry: the template's own keys, so a row sent back unchanged is accepted (only account, dimension and months are read). */
export const GRID_ROW_KEYS = ['account', 'dimension', 'months', 'section', 'account_name', 'account_id', 'dimension_name', 'dimension_id', 'fy_total', 'py_actual'] as const;
const KNOWN = new Set<string>(GRID_ROW_KEYS);

function cellOf(value: unknown): ParsedCell {
  if (value === null) return { kind: 'blank' };
  const money = parseMoney(value);
  if ('error' in money) return { kind: 'error', raw: String(value).slice(0, 40), reason: money.error };
  return { kind: 'value', cents: money.cents };
}

/** The grid's rows as import lines (row = 1-based position in `rows`), or why the request is refused whole. */
export function gridLines(model: GridReadModel, grain: TemplateGrain, rows: unknown): ImportLine[] | string {
  if (!Array.isArray(rows) || rows.length === 0) return 'rows must list at least one row';
  if (rows.length > MAX_GRID_ROWS) return `rows lists ${rows.length} rows; one call takes at most ${MAX_GRID_ROWS} rows (the MCP request is at most 3 MB). Import the grid in parts.`;
  const months = model.year.monthKeys;
  const span = `FY${model.year.fiscalYear} (${months[0]} to ${months[months.length - 1]})`;
  const yearMonths = new Set(months);
  const accountIds = new Set(model.accounts.map((a) => a.id));
  const memberIds = new Set(grain === 'company' ? [] : model.dimensions[grain].map((m) => m.id));
  const byId = (ref: string, ids: Set<string>) => (UUID_RE.test(ref) && ids.has(ref.toLowerCase()) ? ref.toLowerCase() : undefined);
  const lines: ImportLine[] = [];
  for (const [i, r] of rows.entries()) {
    const n = i + 1;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return `row ${n} must be an object { account, dimension?, months }`;
    const o = r as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !KNOWN.has(k));
    if (unknown !== undefined) return `row ${n}: ${JSON.stringify(unknown.slice(0, 40))} is not a field of a template row (account, dimension, months)`;
    if (typeof o.account !== 'string') return `row ${n}: account must be an account code or id`;
    if (grain === 'company' && o.dimension !== undefined && o.dimension !== null) return `row ${n}: dimension is only for a cc1, cc2 or bu grid (send grain)`;
    if (grain !== 'company' && o.dimension !== undefined && typeof o.dimension !== 'string') return `row ${n}: dimension must be a ${grain} member code or id`;
    const m = o.months;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return `row ${n}: months must be an object of YYYY-MM to a decimal string or null`;
    const keys = Object.keys(m);
    const missing = months.filter((k) => !(k in m));
    const extra = keys.filter((k) => !yearMonths.has(k));
    if (missing.length > 0 || extra.length > 0) {
      const why = [missing.length > 0 ? `missing ${missing.slice(0, 3).join(', ')}` : '', extra.length > 0 ? `${JSON.stringify(extra[0]!.slice(0, 20)).slice(1, -1)} is not one` : ''].filter(Boolean).join('; ');
      return `row ${n}: months must list every month of ${span} and no other (null = not budgeted): ${why}`;
    }
    const account = o.account;
    const dimension = grain === 'company' ? null : typeof o.dimension === 'string' ? o.dimension : '';
    const accountId = byId(account.trim(), accountIds);
    const memberId = dimension === null ? undefined : byId(dimension.trim(), memberIds);
    lines.push({
      row: n, accountCode: account, dimensionCode: dimension, ...(accountId ? { accountId } : {}), ...(memberId ? { memberId } : {}),
      amounts: months.map((month) => ({ month, cell: cellOf((m as Record<string, unknown>)[month]) })),
    });
  }
  return lines;
}
