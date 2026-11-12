/** Reads and the one insert of tax_return_versions (wave 5 L1a). */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { ReturnRefusal, STALE_RETURN_REFUSAL, type ReturnForm, type ReturnVersion, type ReturnVersionStatus } from './returnVersionTypes';

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));
const text = (v: unknown): string | null => (v == null ? null : String(v));

export function mapVersion(r: DbRow): ReturnVersion {
  return {
    id: String(r.id),
    formType: r.form_type as ReturnForm,
    periodStart: day(r.period_start),
    periodEnd: day(r.period_end),
    versionNo: Number(r.version_no),
    status: r.status as ReturnVersionStatus,
    figures: (r.figures ?? {}) as Record<string, unknown>,
    postedThrough: iso(r.posted_through),
    vatPeriodLockId: text(r.vat_period_lock_id),
    sarsSubmissionId: text(r.sars_submission_id),
    filedReference: text(r.filed_reference),
    amendsVersionId: text(r.amends_version_id),
    finalisedBy: String(r.finalised_by),
    finalisedAt: iso(r.finalised_at),
    filedBy: text(r.filed_by),
    filedAt: r.filed_at == null ? null : iso(r.filed_at),
    amendedBy: text(r.amended_by),
    amendReason: text(r.amend_reason),
    amendedAt: r.amended_at == null ? null : iso(r.amended_at),
  };
}

/** Every version of one return, newest first. */
export async function listVersionRows(
  companyId: string, form: ReturnForm, periodStart: string, periodEnd: string,
): Promise<ReturnVersion[]> {
  const rows = (await sql`
    SELECT * FROM tax_return_versions
    WHERE company_id = ${companyId}::UUID AND form_type = ${form}
      AND period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE
    ORDER BY version_no DESC
  `) as DbRow[];
  return rows.map(mapVersion);
}

export interface NewVersion {
  companyId: string;
  form: ReturnForm;
  periodStart: string;
  periodEnd: string;
  versionNo: number;
  figures: Record<string, unknown>;
  postedThrough: string;
  vatPeriodLockId: string | null;
  amendsVersionId: string | null;
  finalisedBy: string;
}

export async function insertVersion(v: NewVersion): Promise<ReturnVersion> {
  const rows = (await sql`
    INSERT INTO tax_return_versions (
      company_id, form_type, period_start, period_end, version_no, figures, posted_through,
      vat_period_lock_id, amends_version_id, finalised_by
    ) VALUES (
      ${v.companyId}::UUID, ${v.form}, ${v.periodStart}::DATE, ${v.periodEnd}::DATE, ${v.versionNo},
      ${JSON.stringify(v.figures)}::JSONB, ${v.postedThrough}::TIMESTAMPTZ,
      ${v.vatPeriodLockId}::UUID, ${v.amendsVersionId}::UUID,
      -- users.id is character varying: TEXT, never a UUID cast.
      ${v.finalisedBy}::TEXT
    )
    RETURNING *
  `) as DbRow[];
  return mapVersion(rows[0]!);
}

/**
 * The next version number and the version it amends. Throws nothing: a key with a
 * non-superseded version is refused by the caller before this is asked.
 */
export function nextVersion(existing: ReturnVersion[]): { versionNo: number; amendsVersionId: string | null } {
  const latest = existing[0];
  return latest ? { versionNo: latest.versionNo + 1, amendsVersionId: latest.id } : { versionNo: 1, amendsVersionId: null };
}

/**
 * Refuses (409) when a live (non-superseded) version of this form overlaps the period. Called
 * before the finalise and again once the VAT exclusive key is held, so a concurrent finalise
 * that committed in between is seen.
 */
export async function assertNoLiveOverlap(
  companyId: string, form: ReturnForm, periodStart: string, periodEnd: string,
): Promise<void> {
  const rows = (await sql`
    SELECT version_no, status, period_start, period_end FROM tax_return_versions
    WHERE company_id = ${companyId}::UUID AND form_type = ${form} AND status <> 'superseded'
      AND period_start <= ${periodEnd}::DATE AND period_end >= ${periodStart}::DATE
    LIMIT 1
  `) as DbRow[];
  const r = rows[0];
  if (!r) return;
  const same = day(r.period_start) === periodStart && day(r.period_end) === periodEnd;
  throw new ReturnRefusal(409, same
    ? `This ${form} is already ${String(r.status)} as version ${Number(r.version_no)}. Amend it before finalising again.`
    : `This period overlaps the ${form} already ${String(r.status)} for ${day(r.period_start)} to ${day(r.period_end)}.`,
  same ? STALE_RETURN_REFUSAL.LIVE_VERSION_EXISTS : 'OVERLAPS_LIVE_VERSION');
}
