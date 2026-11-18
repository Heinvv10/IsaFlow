/** What must hold before the verify logins are published: the suite's own preconditions, the two-person shape of the company, and that neither login reaches any other company. */
import type { ClientBase } from 'pg';
import { actorRank, requiredRank } from '../../../src/modules/accounting/services/gl/approvalRank';
import { readSlotReport, slotProblems } from '../../ci/golden/slotVerify';
import type { UserIds } from './provisionDb';

export async function companyProblems(db: ClientBase, companyId: string, ids: UserIds): Promise<string[]> {
  const problems = slotProblems(await readSlotReport(db, companyId), false);
  const members = (await db.query<{ user_id: string; role: string }>(`SELECT user_id, role FROM company_users WHERE company_id = $1::uuid`, [companyId])).rows;
  const role = (id: string) => members.find((m) => m.user_id === id)?.role;
  if (role(ids.verify) !== 'owner') problems.push(`the verify login is not the company's owner (role ${role(ids.verify) ?? 'none'})`);
  const rule = (await db.query<{ approver_role: string | null }>(
    `SELECT approver_role FROM approval_rules WHERE company_id = $1::uuid AND document_type = 'pay_run' AND is_active ORDER BY priority LIMIT 1`, [companyId])).rows[0]?.approver_role ?? 'admin';
  const approver = role(ids.approver);
  if (approver === undefined || actorRank(approver) < requiredRank(rule)) {
    problems.push(`the approver (role ${approver ?? 'none'}) cannot decide a pay run: the company's rule demands ${rule}; the two-person gate would not hold`);
  }
  if (approver === 'owner') problems.push('the approver is an owner of the company: it must stay below the verify login');
  // The approver belongs to this company and nothing else; the verify login only to this one and demo sandboxes (its migration sandbox).
  const other = await db.query<{ user_id: string; name: string; is_demo: boolean }>(
    `SELECT cu.user_id, c.name, c.is_demo FROM company_users cu JOIN companies c ON c.id = cu.company_id
      WHERE cu.user_id = ANY($1::text[]) AND cu.company_id <> $2::uuid`, [[ids.verify, ids.approver], companyId]);
  for (const r of other.rows) {
    if (r.user_id === ids.approver) problems.push(`the approver login also belongs to "${r.name}": it must belong to the verify company only`);
    else if (!r.is_demo) problems.push(`the verify login also belongs to "${r.name}", which is not a demo company`);
  }
  return problems;
}
