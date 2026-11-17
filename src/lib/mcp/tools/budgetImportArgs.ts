/**
 * import_budget_workbook's request checks that need no database (the .xlsx's base64, size and .xls tests, as
 * the import-preview route makes them) and the views its reply adds (conflicts, named by account and member).
 */
import { parseKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { McpToolResult } from '../types';
import { randText } from './budgetToolArgs';
import { cellLabels } from './budgetDiffView';
import { toolError } from './toolHelpers';

/** base64 characters one call takes: about 2.1 MB of .xlsx, under the MCP endpoint's 3 MB body (pages/api/mcp/index.ts). */
export const MAX_WORKBOOK_BASE64 = 2_900_000;
/** Standard base64, padded (what btoa / Buffer give); checked in one linear pass. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CONFLICTS_LISTED = 50;

/** The workbook's bytes, or the refusal for a file the import-preview route would refuse before parsing it. */
export function workbookBytes(raw: unknown, fileName: unknown): Buffer | McpToolResult {
  if (typeof raw === 'string' && raw.length > MAX_WORKBOOK_BASE64) {
    return toolError('The file is larger than one MCP request can carry (about 2 MB of .xlsx as base64; the request is at most 3 MB). Import it in parts: download templates for fewer members, or remove rows you are not changing.');
  }
  if (typeof raw !== 'string' || raw.length === 0 || raw.length % 4 !== 0 || !BASE64.test(raw)) return toolError('file_base64 must be the .xlsx file as standard base64.');
  const bytes = Buffer.from(raw, 'base64');
  if ((typeof fileName === 'string' && fileName.toLowerCase().endsWith('.xls')) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    return toolError('Old-style Excel .xls files are not supported. Save the template as .xlsx and send it again.');
  }
  return bytes;
}

/** Review round 1 (MEDIUM): a template without `_base` diffs against the version now and its `_meta` signature covers nothing; refused as tampered. */
export const NO_BASE_REFUSED = 'This template\'s hidden _base or _meta sheet was changed, so IsaFlow cannot tell what you edited (it has _meta but no _base). '
  + 'Download a fresh template (get_budget_template format xlsx) and make your changes in it, or send a free-form sheet with no _meta sheet, or the JSON grid (rows).';

/** Review round 2: a free-form sheet has no base, so it overwrites; only against the version as the caller read it. */
export const FREEFORM_NEEDS_TOKEN = 'This workbook is a free-form sheet (it has no IsaFlow _meta or _base sheet), so it overwrites: send version_token, the version as you last read it '
  + '(list_budget_versions, get_budget or get_budget_template answer it); the import is refused unless the version is still as you read it.';

export const FREEFORM_OVERWRITE = 'This sheet has no base: every cell it names is set to the sheet\'s value, even if someone changed it after you read version_token '
  + '(only a change since that token is refused); a blank cell keeps its amount and "clear" clears it.';

/** The file's conflicts (changed in the file AND in the version since it was read), named by account, member and month. */
export function conflictView(model: GridReadModel, conflicts: ReadonlyArray<{ key: string; downloaded: number | null; current: number | null; after: number | null }>) {
  const name = cellLabels(model);
  const money = (v: number | null) => (v === null ? null : randText(v));
  return conflicts.slice(0, CONFLICTS_LISTED).map((c) => {
    const ref = parseKey(c.key);
    return { account: name.account(ref.glAccountId), dimension: name.dimension(ref), month: ref.month, downloaded: money(c.downloaded), current: money(c.current), after: money(c.after) };
  });
}
