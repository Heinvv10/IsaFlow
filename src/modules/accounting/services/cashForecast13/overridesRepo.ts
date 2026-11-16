/**
 * Week overrides of the 13-week forecast (cash_forecast_overrides, migration 999i). One override per
 * (company, line key, week): a save UPSERTS on that key (a second save of the same cell replaces the
 * first, never a 409). Deletes by id. Every write runs in the request transaction, refuses a Login-as
 * session first, and writes one audit row (entity_type 'cash_forecast_override') with the old and new
 * values. The table's trigger stamps who and when.
 */
import { sql } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { toIsoTimestamp } from '@/lib/dateUtils';
import type { DbRow } from '@/types/db';
import { logAuditOrThrow, type AuditFieldChange } from '../core/auditTrailService';
import { CashForecastNotFoundError } from './storeErrors';
import type { OverrideInput } from './storeSchemas';
import type { ForecastOverride, OverrideMode } from './storeTypes';

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

export async function listOverrides(companyId: string): Promise<StoredOverride[]> {
  const rows = (await sql`
    SELECT ${COLUMNS} FROM cash_forecast_overrides WHERE company_id = ${companyId}::UUID ORDER BY created_at, id
  `) as DbRow[];
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
export async function saveOverride(companyId: string, userId: string, input: OverrideInput): Promise<{ override: StoredOverride; created: boolean }> {
  await assertNotImpersonating();
  const prior = (await sql`
    SELECT ${COLUMNS} FROM cash_forecast_overrides
     WHERE company_id = ${companyId}::UUID AND line_key = ${input.lineKey} AND week_start = ${input.weekStart}::DATE
     FOR UPDATE
  `) as DbRow[];
  const before = prior[0] ? toOverride(prior[0]) : null;
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

export async function deleteOverride(companyId: string, userId: string, id: string): Promise<void> {
  await assertNotImpersonating();
  const rows = (await sql`
    DELETE FROM cash_forecast_overrides WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID RETURNING ${COLUMNS}
  `) as DbRow[];
  if (rows.length === 0) throw new CashForecastNotFoundError('No such cash forecast override');
  const before = toOverride(rows[0]!);
  await logAuditOrThrow({
    companyId, userId, action: 'delete', entityType: 'cash_forecast_override', entityId: id,
    entityRef: `${before.lineKey} @ ${before.weekStart}`,
    changes: { fields: changes(before, null), metadata: { area: 'cash_forecast_13', lineKey: before.lineKey, weekStart: before.weekStart } },
  });
}
