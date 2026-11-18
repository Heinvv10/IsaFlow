/**
 * The reseed's pay runs and migration 999n (wave 6 FZ). The database freezes a final run (approved or paid with an
 * approval stamp): its lines take no INSERT, UPDATE or DELETE, and production's postgres is bound by it. So the
 * reseed reopens the Demo's final runs before the wipe (the app's reopen: status back to calculated, stamps cleared),
 * inserts each generated run as calculated, adds its lines, and only then moves it to its generated status and stamps.
 */
import type { Tx } from './db';
import type { Row } from './journal';

const FINAL = new Set(['approved', 'paid']);
const FINAL_FIELDS = ['status', 'approved_at', 'approval_grandfathered_at'] as const;

/** Reopen every final Demo run so the wipe may delete its lines. Returns how many were reopened. */
export async function reopenFinalRuns(tx: Tx, companyId: string): Promise<number> {
  const rows = await tx.query(
    `UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL, approval_grandfathered_at = NULL
      WHERE company_id = $1::uuid AND status IN ('approved', 'paid') RETURNING id`, [companyId]);
  return rows.length;
}

/** The headers to insert (final ones as calculated, without stamps), and what each final one becomes afterwards. */
export function splitFinalHeaders(headers: Row[]): { insert: Row[]; finals: Row[] } {
  const finals: Row[] = [];
  const insert = headers.map((h) => {
    if (!FINAL.has(String(h.status))) return h;
    finals.push(Object.fromEntries([['id', h.id], ...FINAL_FIELDS.map((f) => [f, h[f] ?? null])]));
    return { ...h, status: 'calculated', approved_at: null, approval_grandfathered_at: null };
  });
  return { insert, finals };
}

/** Move each run to its generated final status and stamps, after its lines are in. */
export async function finaliseRuns(tx: Tx, companyId: string, finals: Row[]): Promise<void> {
  for (const f of finals) {
    const done = await tx.query(
      `UPDATE payroll_run_headers SET status = $3, approved_at = $4::timestamptz, approval_grandfathered_at = $5::timestamptz
        WHERE id = $1::uuid AND company_id = $2::uuid AND status = 'calculated' RETURNING id`,
      [f.id, companyId, f.status, f.approved_at, f.approval_grandfathered_at]);
    if (done.length !== 1) throw new Error(`pay run ${String(f.id)} was not finalised`);
  }
}
