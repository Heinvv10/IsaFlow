/**
 * import_budget_workbook's JSON grid (get_budget_template's rows, edited) read into the Excel import's own
 * lines (`ImportLine`) and base, so it is resolved and diffed 3-way by exactly the code an uploaded workbook is
 * (`budgetImportDiff.diffImportLines`). Each row carries the signed `base` it was read with
 * (`budgetTemplateSignature.encodeRowBase`): its account and member ARE the row (an id, so a duplicate code
 * resolves), and its months as read are what the row is diffed against, whatever page or token it came from
 * (review round 1, HIGH). The request's SHAPE is refused whole, like a workbook's layout or a tampered `_base`
 * (no base, an altered or foreign base, a row naming another account or member than its base, months that are
 * not exactly the year's, a dimension on a company grid, a field no template row has); what one row SAYS (an
 * amount that is not a decimal string) becomes that row's error in the import's resolver, listed with its reason.
 */
import { UUID_RE } from '@/lib/validation';
import type { ImportLine } from '@/modules/accounting/services/budgets/budgetImportParse';
import { decodeRowBase } from '@/modules/accounting/services/budgets/budgetTemplateSignature';
import { templateRowKey, type TemplateGrain } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import type { ParsedCell } from '@/modules/accounting/services/budgets/grid/pasteParse';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { parseMoney } from './budgetToolArgs';

/** Rows one call takes: ~1 KB each sent back whole (base, months, names), so ~2 MB under the 3 MB MCP body limit. */
export const MAX_GRID_ROWS = 2000;

/** What a row may carry: the template's own keys, so a row sent back unchanged is accepted. */
export const GRID_ROW_KEYS = ['account', 'dimension', 'months', 'base', 'section', 'account_name', 'account_id', 'dimension_name', 'dimension_id', 'fy_total', 'py_actual'] as const;
const KNOWN = new Set<string>(GRID_ROW_KEYS);

function cellOf(value: unknown): ParsedCell {
  if (value === null) return { kind: 'blank' };
  const money = parseMoney(value);
  if ('error' in money) return { kind: 'error', raw: String(value).slice(0, 40), reason: money.error };
  return { kind: 'value', cents: money.cents };
}

/** A reference (`account`, `account_id`, …) that, when given, must name `id` (by id, or by `code`). */
const names = (ref: unknown, id: string, code: string | undefined): boolean => {
  if (ref === undefined || ref === null) return true;
  if (typeof ref !== 'string') return false;
  const t = ref.trim();
  return (UUID_RE.test(t) && t.toLowerCase() === id) || (code !== undefined && (ref === code || t === code.trim()));
};

export interface GridSource { lines: ImportLine[]; base: Map<string, ReadonlyArray<number | null>> }

/** The grid's rows as import lines (row = 1-based position in `rows`) and their bases by row key, or why the request is refused whole. */
export function gridLines(model: GridReadModel, grain: TemplateGrain, rows: unknown): GridSource | string {
  if (!Array.isArray(rows) || rows.length === 0) return 'rows must list at least one row';
  if (rows.length > MAX_GRID_ROWS) return `rows lists ${rows.length} rows; one call takes at most ${MAX_GRID_ROWS} rows (the MCP request is at most 3 MB). Import the grid in parts.`;
  const meta = { versionId: model.version!.id, fiscalYear: model.year.fiscalYear, grain, months: model.year.monthKeys };
  const months = model.year.monthKeys;
  const span = `FY${model.year.fiscalYear} (${months[0]} to ${months[months.length - 1]})`;
  const yearMonths = new Set(months);
  const accounts = new Map(model.accounts.map((a) => [a.id, a]));
  const members = new Map((grain === 'company' ? [] : model.dimensions[grain]).map((m) => [m.id, m]));
  const lines: ImportLine[] = [];
  const base = new Map<string, ReadonlyArray<number | null>>();
  for (const [i, r] of rows.entries()) {
    const n = i + 1;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return `row ${n} must be an object { account, dimension?, months, base }`;
    const o = r as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !KNOWN.has(k));
    if (unknown !== undefined) return `row ${n}: ${JSON.stringify(unknown.slice(0, 40))} is not a field of a template row (account, dimension, months, base)`;
    if (grain === 'company' && o.dimension !== undefined && o.dimension !== null) return `row ${n}: dimension is only for a cc1, cc2 or bu grid (send grain)`;
    if (typeof o.base !== 'string') return `row ${n}: base is required: send each row with the base get_budget_template returned for it (rows cannot be added; read the template row of the account you want)`;
    const read = decodeRowBase(meta, o.base);
    if (read === null) { // the grain is signed: a company base never decodes on a cc1 grid, nor the reverse
      return `row ${n}: its base was changed or was read for another version, grain or row, so IsaFlow cannot tell what you edited. Read the rows again with get_budget_template and edit those.`;
    }
    const account = accounts.get(read.accountId);
    const member = read.memberId === null ? undefined : members.get(read.memberId);
    if (!names(o.account, read.accountId, account?.code)) return `row ${n}: account ${String(o.account).slice(0, 40)} is not the account its base was read for (${account?.code ?? read.accountId})`;
    if (!names(o.account_id, read.accountId, undefined)) return `row ${n}: account_id ${String(o.account_id).slice(0, 40)} is not the account its base was read for (${read.accountId})`;
    if (read.memberId !== null && !names(o.dimension, read.memberId, member?.code)) return `row ${n}: dimension ${String(o.dimension).slice(0, 40)} is not the member its base was read for (${member?.code ?? read.memberId})`;
    if (read.memberId !== null && !names(o.dimension_id, read.memberId, undefined)) return `row ${n}: dimension_id ${String(o.dimension_id).slice(0, 40)} is not the member its base was read for (${read.memberId})`;
    const m = o.months;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return `row ${n}: months must be an object of YYYY-MM to a decimal string or null`;
    const missing = months.filter((k) => !(k in m));
    const extra = Object.keys(m).filter((k) => !yearMonths.has(k));
    if (missing.length > 0 || extra.length > 0) {
      const why = [missing.length > 0 ? `missing ${missing.slice(0, 3).join(', ')}` : '', extra.length > 0 ? `${JSON.stringify(extra[0]!.slice(0, 20)).slice(1, -1)} is not one` : ''].filter(Boolean).join('; ');
      return `row ${n}: months must list every month of ${span} and no other (null = not budgeted): ${why}`;
    }
    lines.push({
      row: n, accountCode: account?.code ?? read.accountId, dimensionCode: read.memberId === null ? null : member?.code ?? read.memberId,
      accountId: read.accountId, ...(read.memberId === null ? {} : { memberId: read.memberId }),
      amounts: months.map((month) => ({ month, cell: cellOf((m as Record<string, unknown>)[month]) })),
    });
    base.set(templateRowKey(read.accountId, grain, read.memberId), read.cents);
  }
  return { lines, base };
}
