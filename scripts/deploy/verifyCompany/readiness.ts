/** What must hold before the verify logins are published: the suite's own preconditions, and the two-person shape of the company. */
import type { ClientBase } from 'pg';
import { readSlotReport, slotProblems } from '../../ci/golden/slotVerify';
import { APPROVER_ROLE } from './identity';
import type { UserIds } from './provisionDb';

export async function companyProblems(db: ClientBase, companyId: string, ids: UserIds): Promise<string[]> {
  const problems = slotProblems(await readSlotReport(db, companyId), false);
  const members = (await db.query<{ user_id: string; role: string }>(`SELECT user_id, role FROM company_users WHERE company_id = $1::uuid`, [companyId])).rows;
  const role = (id: string) => members.find((m) => m.user_id === id)?.role;
  if (role(ids.verify) !== 'owner') problems.push(`the verify login is not the company's owner (role ${role(ids.verify) ?? 'none'})`);
  if (role(ids.approver) !== APPROVER_ROLE) problems.push(`the approver is not a ${APPROVER_ROLE} of the company (role ${role(ids.approver) ?? 'none'}): the pay-run two-person gate would not hold`);
  return problems;
}
