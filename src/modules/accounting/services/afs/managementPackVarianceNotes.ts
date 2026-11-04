/**
 * The APPROVED budget variance notes the management pack prints under its `budget_variance` table
 * (budgets P5 spec §3e). The notes are those of the version the pack's budget figures come from, for the
 * months of the pack's window; a draft never prints (`listApprovedVarianceNotes`). They are section
 * blocks, rendered (and escaped) by the AFS renderers like any other block; they never reach the board
 * pack's page 4, which reads `report_kind = 'pack'` only.
 */
import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listApprovedVarianceNotes, type ApprovedVarianceNote } from '../commentary/varianceCommentary';
import type { BudgetTrackingReport } from '../budgets/tracking/trackingTypes';
import type { NoteContentBlock } from './afsTypes';

export const VARIANCE_NOTES_HEADING = 'Variance commentary';
/** Fixed text: a pack goes to external recipients and a database message can carry internals. */
export const VARIANCE_NOTES_UNAVAILABLE = 'Variance commentary is unavailable for this month.';

async function labels(companyId: string, notes: readonly ApprovedVarianceNote[]): Promise<Map<string, string>> {
  const accounts = [...new Set(notes.map((n) => n.glAccountId))];
  const centres = [...new Set(notes.flatMap((n) => [n.cc1Id, n.cc2Id]).filter((x): x is string => x !== null))];
  const units = [...new Set(notes.map((n) => n.buId).filter((x): x is string => x !== null))];
  const out = new Map<string, string>();
  const put = (rows: DbRow[], text: (r: DbRow) => string) => rows.forEach((r) => out.set(String(r.id).toLowerCase(), text(r)));
  put((await sql`SELECT id::TEXT AS id, account_code, account_name FROM gl_accounts
                 WHERE company_id = ${companyId}::UUID AND id = ANY(${accounts}::UUID[])`) as DbRow[],
  (r) => `${String(r.account_code)} ${String(r.account_name)}`);
  if (centres.length > 0) {
    put((await sql`SELECT id::TEXT AS id, code, name FROM cost_centres
                   WHERE company_id = ${companyId}::UUID AND id = ANY(${centres}::UUID[])`) as DbRow[],
    (r) => `${String(r.code)} ${String(r.name)}`);
  }
  if (units.length > 0) {
    put((await sql`SELECT id::TEXT AS id, code, name FROM business_units
                   WHERE company_id = ${companyId}::UUID AND id = ANY(${units}::UUID[])`) as DbRow[],
    (r) => `${String(r.code)} ${String(r.name)}`);
  }
  return out;
}

/** "6000 Rent · CC1 FT Fibre, BU B1 Gauteng: text" (the month first when the window has several). */
export function varianceNoteLine(n: ApprovedVarianceNote, names: ReadonlyMap<string, string>, withMonth: boolean): string {
  const name = (id: string | null) => (id === null ? null : names.get(id.toLowerCase()) ?? null);
  const dims = [n.cc1Id, n.cc2Id, n.buId].map(name).filter((x): x is string => x !== null);
  const account = name(n.glAccountId) ?? 'Account';
  const slice = dims.length > 0 ? `${account} · ${dims.join(', ')}` : account;
  return `${withMonth ? `${n.month} ` : ''}${slice}: ${n.text}`;
}

/**
 * The blocks to print under the variance table: none when there is no note (or no version), a heading
 * and one list item per note otherwise. A failed read prints the fixed unavailable sentence and is
 * logged: the pack still goes out. The reads run in a savepoint so a failure does not abort the
 * request transaction the pack is then written in.
 */
export async function loadPackVarianceNoteBlocks(companyId: string, report: BudgetTrackingReport): Promise<NoteContentBlock[]> {
  const version = report.version;
  if (!version) return [];
  try {
    return await withSavepoint('mgmt_pack_variance_notes', async () => {
      const notes = await listApprovedVarianceNotes(companyId, version.id, report.window.months);
      if (notes.length === 0) return [];
      const names = await labels(companyId, notes);
      const withMonth = report.window.months.length > 1;
      // Month, then account code and slice: the order a reader scans the table in (row_ref is ids).
      const items = notes.map((n) => varianceNoteLine(n, names, withMonth)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return [
        { type: 'heading', level: 3, text: VARIANCE_NOTES_HEADING },
        { type: 'list', items },
      ] satisfies NoteContentBlock[];
    });
  } catch (err) {
    log.error('management pack: the variance notes could not be read; the section prints the unavailable sentence', {
      companyId, versionId: version.id, error: err instanceof Error ? err.message : String(err),
    }, 'managementPackVarianceNotes');
    return [{ type: 'paragraph', text: VARIANCE_NOTES_UNAVAILABLE }];
  }
}
