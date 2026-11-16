/**
 * What the run prints about its target, and the refusals it makes before any
 * write (PLAN 2.1, 4.3): the company must exist and be the demo, the role must
 * bypass RLS, nothing may be unclassified, no intercompany link, and supplier
 * payment approval must not be enforced (paid payments cannot be seeded
 * without forging approvals, which the tool never does).
 */

import { Refusal } from './cli';
import type { Tx } from './db';
import { censusUnclassified, intercompanyCount, missingWipeTables } from './wipe';

export async function describeSession(tx: Tx, companyId: string, out: (s: string) => void): Promise<{ dbToday: string }> {
  const [s] = await tx.query<{ db: string; cu: string; su: string; bypass: boolean; today: string }>(`
    SELECT current_database() AS db, current_user AS cu, session_user AS su,
      (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS bypass,
      ((now() AT TIME ZONE 'Africa/Johannesburg')::date)::text AS today`);
  const [c] = await tx.query<{ name: string; is_demo: boolean }>('SELECT name, is_demo FROM companies WHERE id = $1::uuid', [companyId]);
  out(`session: database=${s!.db} current_user=${s!.cu} session_user=${s!.su} bypasses_rls=${s!.bypass} today(SAST)=${s!.today}`);
  out(`company: ${companyId} name="${c?.name ?? '(none)'}" is_demo=${c?.is_demo ?? '(none)'}`);
  if (!c) throw new Refusal(`company ${companyId} does not exist in this database`);
  if (c.is_demo !== true) throw new Refusal(`company ${companyId} is not flagged is_demo`);
  if (!s!.bypass) throw new Refusal(`role ${s!.cu} neither bypasses RLS nor is a superuser: an RLS-filtered wipe would delete nothing`);
  return { dbToday: s!.today };
}

export async function refuseUnsafe(tx: Tx, companyId: string, out: (s: string) => void): Promise<void> {
  const missing = await missingWipeTables(tx);
  if (missing.length > 0) throw new Refusal(`wipe plan names tables this database lacks: ${missing.join(', ')}`);
  const unclassified = await censusUnclassified(tx, companyId);
  if (unclassified.length > 0) {
    throw new Refusal(`tables hold Demo rows but are in neither the wipe nor the keep list: ${unclassified.map((u) => `${u.table} (${u.n})`).join(', ')}`);
  }
  const ic = await intercompanyCount(tx, companyId);
  if (ic > 0) throw new Refusal(`${ic} intercompany_transactions row(s) name Demo journals: not handled, resolve them first`);
  const enforced = (await tx.query<{ document_type: string }>(
    'SELECT document_type FROM approval_enforcement WHERE company_id = $1::uuid ORDER BY 1', [companyId])).map((r) => r.document_type);
  out(`approval enforcement on the company: ${enforced.join(', ') || 'none'}`);
  if (enforced.includes('supplier_payment')) {
    throw new Refusal('supplier_payment approval is enforced on the Demo company; the reseed cannot insert paid supplier payments without forging approvals');
  }
}
