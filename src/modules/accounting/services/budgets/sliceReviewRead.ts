/**
 * Reads of budget slice reviews (budgets P5-6): one slice, a slice's holders, the company's
 * reviewers, and the review board's list. Every query names the company. An owner or admin sees
 * every slice; anyone else only the slices they hold (holder rows of their own user id).
 * Names come from 714's reviewed definer `approval_company_member_name` (members of the caller's
 * own company only); the reviewers a submit notifies from 708's `approval_company_other_members`
 * (a manager cannot read the owners' company_users rows). No new definer.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { BudgetVersionError, type BudgetVersionStatus } from './budgetVersionTypes';
import type { SliceKey, SliceStatus } from './holderSlices';

export interface SliceHolder {
  userId: string;
  name: string | null;
  /** null: every account of the slice. */
  glAccountIds: string[] | null;
}

export interface SliceReview extends SliceKey {
  id: string;
  versionId: string;
  versionName: string;
  fiscalYear: number;
  versionStatus: BudgetVersionStatus;
  /** "CC1 OPS Operations", "BU …", or "Company level". */
  label: string;
  status: SliceStatus;
  /** 'YYYY-MM-DD' or null. */
  dueDate: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  holders: SliceHolder[];
}

const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const SLICE_SELECT = (companyId: string) => sql`
  SELECT r.id::TEXT AS id, r.version_id::TEXT AS version_id, v.name AS version_name, v.fiscal_year, v.status AS version_status,
         r.cc1_id::TEXT AS cc1_id, r.cc2_id::TEXT AS cc2_id, r.bu_id::TEXT AS bu_id, r.status, r.due_date::TEXT AS due_date,
         r.submitted_by, to_char(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at,
         r.decided_by, to_char(r.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS decided_at, r.decision_note,
         CASE WHEN r.cc1_id IS NOT NULL THEN 'CC1 ' || COALESCE(c1.code || ' ' || c1.name, r.cc1_id::TEXT)
              WHEN r.cc2_id IS NOT NULL THEN 'CC2 ' || COALESCE(c2.code || ' ' || c2.name, r.cc2_id::TEXT)
              WHEN r.bu_id IS NOT NULL THEN 'BU ' || COALESCE(b.code || ' ' || b.name, r.bu_id::TEXT)
              ELSE 'Company level' END AS label
    FROM budget_slice_reviews r
    JOIN budget_versions v ON v.id = r.version_id AND v.company_id = r.company_id
    LEFT JOIN cost_centres c1 ON c1.id = r.cc1_id AND c1.company_id = r.company_id
    LEFT JOIN cost_centres c2 ON c2.id = r.cc2_id AND c2.company_id = r.company_id
    LEFT JOIN business_units b ON b.id = r.bu_id AND b.company_id = r.company_id
   WHERE r.company_id = ${companyId}::UUID`;

function mapSlice(r: DbRow, holders: SliceHolder[]): SliceReview {
  return {
    id: String(r.id), versionId: String(r.version_id), versionName: String(r.version_name), fiscalYear: Number(r.fiscal_year),
    versionStatus: String(r.version_status) as BudgetVersionStatus, cc1Id: text(r.cc1_id), cc2Id: text(r.cc2_id), buId: text(r.bu_id),
    label: String(r.label), status: String(r.status) as SliceStatus, dueDate: text(r.due_date),
    submittedBy: text(r.submitted_by), submittedAt: text(r.submitted_at), decidedBy: text(r.decided_by), decidedAt: text(r.decided_at),
    decisionNote: text(r.decision_note), holders,
  };
}

async function holdersOf(companyId: string, sliceIds: string[]): Promise<Map<string, SliceHolder[]>> {
  const out = new Map<string, SliceHolder[]>();
  if (sliceIds.length === 0) return out;
  const rows = (await sql`
    SELECT r.id::TEXT AS slice_id, h.user_id, h.gl_account_ids::TEXT[] AS accounts,
           public.approval_company_member_name(h.company_id, h.user_id) AS name
      FROM budget_slice_reviews r
      JOIN budget_holders h ON h.company_id = r.company_id AND h.version_id = r.version_id
       AND h.cc1_id IS NOT DISTINCT FROM r.cc1_id AND h.cc2_id IS NOT DISTINCT FROM r.cc2_id AND h.bu_id IS NOT DISTINCT FROM r.bu_id
     WHERE r.company_id = ${companyId}::UUID AND r.id = ANY(${sliceIds}::UUID[])
     ORDER BY h.created_at, h.user_id
  `) as DbRow[];
  for (const r of rows) {
    const list = out.get(String(r.slice_id)) ?? [];
    list.push({ userId: String(r.user_id), name: text(r.name), glAccountIds: Array.isArray(r.accounts) ? (r.accounts as unknown[]).map(String) : null });
    out.set(String(r.slice_id), list);
  }
  return out;
}

/** One slice of the company (another company's id is 404). */
export async function readSlice(companyId: string, sliceId: string): Promise<SliceReview> {
  const rows = (await sql`${SLICE_SELECT(companyId)} AND r.id = ${sliceId}::UUID`) as DbRow[];
  if (!rows[0]) throw new BudgetVersionError('BUDGET_SLICE_NOT_FOUND', 'Budget slice not found');
  return mapSlice(rows[0], (await holdersOf(companyId, [sliceId])).get(sliceId) ?? []);
}

/** The user ids holding this slice (same version, same dimensions). */
export async function sliceHolderIds(companyId: string, slice: SliceKey & { versionId: string }): Promise<string[]> {
  const rows = (await sql`
    SELECT h.user_id FROM budget_holders h
     WHERE h.company_id = ${companyId}::UUID AND h.version_id = ${slice.versionId}::UUID
       AND h.cc1_id IS NOT DISTINCT FROM ${slice.cc1Id}::UUID AND h.cc2_id IS NOT DISTINCT FROM ${slice.cc2Id}::UUID
       AND h.bu_id IS NOT DISTINCT FROM ${slice.buId}::UUID
  `) as DbRow[];
  return rows.map((r) => String(r.user_id));
}

/** The company's active owners and admins other than the caller (a submit notifies them). */
export async function sliceReviewers(companyId: string, callerId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT m.user_id FROM public.approval_company_other_members(${companyId}::UUID, ${callerId}) m
     WHERE m.role IN ('owner', 'admin') AND COALESCE(m.is_active, true) AND m.suspended_at IS NULL
       AND m.status IS DISTINCT FROM 'suspended'
  `) as DbRow[];
  return rows.map((r) => String(r.user_id));
}

/**
 * The review board: an owner's or admin's every slice (of one version, or of every version), anyone
 * else's own slices only. Newest version first, then due date (none last), then label.
 */
export async function listSlices(
  companyId: string, actor: { userId: string; role: string }, opts: { versionId?: string } = {},
): Promise<SliceReview[]> {
  const reviewer = actor.role === 'owner' || actor.role === 'admin';
  const versionId = opts.versionId ?? null;
  const rows = (await sql`${SLICE_SELECT(companyId)}
     AND (${versionId}::UUID IS NULL OR r.version_id = ${versionId}::UUID)
     AND (${reviewer}::BOOLEAN OR EXISTS (
          SELECT 1 FROM budget_holders h
           WHERE h.company_id = r.company_id AND h.version_id = r.version_id AND h.user_id = ${actor.userId}
             AND h.cc1_id IS NOT DISTINCT FROM r.cc1_id AND h.cc2_id IS NOT DISTINCT FROM r.cc2_id AND h.bu_id IS NOT DISTINCT FROM r.bu_id))
   ORDER BY v.fiscal_year DESC, v.created_at DESC, r.due_date NULLS LAST, label
   LIMIT 500`) as DbRow[];
  const holders = await holdersOf(companyId, rows.map((r) => String(r.id)));
  return rows.map((r) => mapSlice(r, holders.get(String(r.id)) ?? []));
}
