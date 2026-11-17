/**
 * Week overrides of the 13-week forecast (cash_forecast_overrides, migration 999i). One override per
 * (company, line key, week): a save UPSERTS on that key (a second save of the same cell replaces the
 * first, never a 409; a save that changes nothing writes nothing). A new cell must be this week or later (400) and fit the
 * caps (storeCaps: MAX_OVERRIDES live, MAX_OVERRIDES_TOTAL in all; 409 on
 * a new cell). Listed in application order (applied_at, id): the trigger moves a cell to the end only when its
 * mode, amount or target changes, so a note-only edit keeps its place. An override on a 'manual:<id>' line needs
 * that item to exist for the company (404), checked FOR SHARE so a concurrent delete waits. Deletes by id. Every write runs in the request transaction, refuses a Login-as
 * session first, and writes one audit row (entity_type 'cash_forecast_override') with the old and new
 * values. The table's trigger stamps who and when.
 */
import { sql } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { toIsoTimestamp } from '@/lib/dateUtils';
import type { DbRow } from '@/types/db';
import { logAuditOrThrow, type AuditFieldChange } from '../core/auditTrailService';
import { CashForecastInputError, CashForecastNotFoundError } from './storeErrors';
import type { OverrideInput } from './storeSchemas';
import { manualLineKey, type ForecastOverride, type OverrideMode } from './storeTypes';
import { isUuidParam } from '@/lib/validation';
import { assertOverrideRoom, liveWindow, lockOverrideWrites } from './storeCaps';

const MANUAL_PREFIX = 'manual:';

/**
 * A manual item's line key in its one stored spelling, `manualLineKey(lowercase id)`: the spelling deleteItem
 * cleans up. Any other key is returned as given. 'manual:' in any case with no UUID after it is a 400.
 */
export function canonicalLineKey(lineKey: string): string {
  if (lineKey.slice(0, MANUAL_PREFIX.length).toLowerCase() !== MANUAL_PREFIX) return lineKey;
  const id = lineKey.slice(MANUAL_PREFIX.length);
  if (!isUuidParam(id)) throw new CashForecastInputError('A manual line key is manual:<item id>');
  return manualLineKey(id.toLowerCase());
}

/** A canonical 'manual:<id>' line belongs to an item of the company; the row lock holds it until the tx ends. */
async function assertManualLine(companyId: string, lineKey: string): Promise<void> {
  if (!lineKey.startsWith(MANUAL_PREFIX)) return;
  const id = lineKey.slice(MANUAL_PREFIX.length);
  const rows = (await sql`SELECT 1 FROM cash_forecast_items WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR SHARE`) as DbRow[];
  if (rows.length === 0) throw new CashForecastNotFoundError('No such cash forecast item for this line');
}

export interface StoredOverride extends ForecastOverride { id: string; note: string | null; createdAt: string; updatedAt: string }

const MODES: readonly OverrideMode[] = ['set', 'add', 'move_to'];

function toOverride(r: DbRow): StoredOverride {
  const o: StoredOverride = {
    id: String(r.id),
    lineKey: String(r.line_key),
    weekStart: String(r.week_start),
    mode: MODES.find((m) => m === r.mode) ?? 'set',
    amount: r.amount == null ? null : Number(r.amount),
    note: r.note == null ? null : String(r.note),
    createdAt: toIsoTimestamp(r.created_at as Date | string) ?? '',
    updatedAt: toIsoTimestamp(r.updated_at as Date | string) ?? '',
  };
  if (r.target_week_start != null) o.targetWeekStart = String(r.target_week_start);
  return o;
}

const COLUMNS = sql`id, line_key, week_start::text AS week_start, mode, amount, target_week_start::text AS target_week_start,
  note, created_at, updated_at`;

/** Every override (the management list), or with `fromMonday` only weeks from it on (what the engine reads). */
export async function listOverrides(companyId: string, fromMonday?: string): Promise<StoredOverride[]> {
  const rows = (fromMonday === undefined
    ? await sql`SELECT ${COLUMNS} FROM cash_forecast_overrides WHERE company_id = ${companyId}::UUID ORDER BY applied_at, id`
    : await sql`
        SELECT ${COLUMNS} FROM cash_forecast_overrides
         WHERE company_id = ${companyId}::UUID AND week_start >= ${fromMonday}::DATE ORDER BY applied_at, id`) as DbRow[];
  return rows.map(toOverride);
}

const LABELS = { mode: 'Mode', amount: 'Amount', targetWeekStart: 'Moved to week', note: 'Note' } as const;
type Tracked = keyof typeof LABELS;

function changes(before: StoredOverride | null, after: StoredOverride | null): AuditFieldChange[] {
  const val = (o: StoredOverride | null, k: Tracked) => {
    const v = o?.[k];
    return v == null ? null : String(v);
  };
  return (Object.keys(LABELS) as Tracked[])
    .filter((k) => val(before, k) !== val(after, k))
    .map((k) => ({ field: k, label: LABELS[k], old: val(before, k), new: val(after, k) }));
}

/** Upsert on (company, lineKey, weekStart). `created` says whether the cell had no override before. */
export async function saveOverride(companyId: string, userId: string, given: OverrideInput): Promise<{ override: StoredOverride; created: boolean }> {
  await assertNotImpersonating();
  const input = { ...given, lineKey: canonicalLineKey(given.lineKey) };
  // One saver per company at a time (to the end of the request tx), so two new cells at the cap cannot both pass.
  await lockOverrideWrites(companyId);
  await assertManualLine(companyId, input.lineKey);
  const prior = (await sql`
    SELECT ${COLUMNS} FROM cash_forecast_overrides
     WHERE company_id = ${companyId}::UUID AND line_key = ${input.lineKey} AND week_start = ${input.weekStart}::DATE
     FOR UPDATE
  `) as DbRow[];
  const before = prior[0] ? toOverride(prior[0]) : null;
  if (before === null) {
    // A new cell must be in a week the engine reads (a past one would be dead on arrival); then the caps.
    const w = liveWindow();
    if (input.weekStart < w.monday) throw new CashForecastInputError('The week must be this week or later');
    await assertOverrideRoom(companyId, w);
  } else if (changes(before, { ...before, ...input, targetWeekStart: input.targetWeekStart ?? undefined }).length === 0) {
    // Nothing changed: no UPDATE (the stamps, and so the application order, stay) and no audit row.
    return { override: before, created: false };
  }
  const rows = (await sql`
    INSERT INTO cash_forecast_overrides (company_id, line_key, week_start, mode, amount, target_week_start, note)
    VALUES (${companyId}::UUID, ${input.lineKey}, ${input.weekStart}::DATE, ${input.mode}, ${input.amount},
            ${input.targetWeekStart}::DATE, ${input.note})
    ON CONFLICT (company_id, line_key, week_start) DO UPDATE
       SET mode = EXCLUDED.mode, amount = EXCLUDED.amount, target_week_start = EXCLUDED.target_week_start, note = EXCLUDED.note
    RETURNING ${COLUMNS}, (xmax = 0) AS inserted
  `) as DbRow[];
  const override = toOverride(rows[0]!);
  // xmax = 0: this statement inserted the row. A row a concurrent save inserted after the SELECT is an
  // update whose audit row has no old values.
  const created = rows[0]!.inserted === true;
  await logAuditOrThrow({
    companyId, userId, action: created ? 'create' : 'update', entityType: 'cash_forecast_override', entityId: override.id,
    entityRef: `${override.lineKey} @ ${override.weekStart}`,
    changes: { fields: changes(before, override), metadata: { area: 'cash_forecast_13', lineKey: override.lineKey, weekStart: override.weekStart } },
  });
  return { override, created };
}

const audited = (companyId: string, userId: string, before: StoredOverride) => logAuditOrThrow({
  companyId, userId, action: 'delete', entityType: 'cash_forecast_override', entityId: before.id,
  entityRef: `${before.lineKey} @ ${before.weekStart}`,
  changes: { fields: changes(before, null), metadata: { area: 'cash_forecast_13', lineKey: before.lineKey, weekStart: before.weekStart } },
});

export async function deleteOverride(companyId: string, userId: string, id: string): Promise<void> {
  await assertNotImpersonating();
  const rows = (await sql`
    DELETE FROM cash_forecast_overrides WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID RETURNING ${COLUMNS}
  `) as DbRow[];
  if (rows.length === 0) throw new CashForecastNotFoundError('No such cash forecast override');
  await audited(companyId, userId, toOverride(rows[0]!));
}

/** Every override of one line (a deleted item's 'manual:<id>'), one audit row each. The caller checked Login-as. */
export async function deleteOverridesOfLine(companyId: string, userId: string, lineKey: string): Promise<void> {
  const rows = (await sql`
    DELETE FROM cash_forecast_overrides WHERE company_id = ${companyId}::UUID AND line_key = ${lineKey} RETURNING ${COLUMNS}
  `) as DbRow[];
  for (const r of rows.map(toOverride).sort((x, y) => (x.weekStart < y.weekStart ? -1 : 1))) await audited(companyId, userId, r);
}
