/**
 * Intercompany connections (P1): create a GROUP connection, revoke one, and (in the sibling services) edit the
 * pair's settings and this company's own side. Rules, in the service and again in the database (999z): both
 * companies are current members of one group and the caller can write in both; a revoked group connection is
 * re-activated, never duplicated; either party may revoke. External connections arrive in P6. Messages,
 * accepting, pairing, loans and interest are later phases.
 */
import { sql } from '@/lib/neon';
import { userCanWriteCompany } from '@/modules/accounting/services/core/companyAccessService';
import { listConnections } from './connectionRead';
import { orderedPair } from './connectionValidation';
import { ConnectionRefusal, type ConnectionView } from './connectionTypes';

export { listConnections, listGroupCandidates } from './connectionRead';
export { updateOwnSide } from './connectionSideService';
export { updateConnectionSettings } from './connectionSettingsService';

type Row = Record<string, unknown>;

/** The connection as this company sees it, or a 404: it was written a moment ago, so a miss means it is not this company's. */
export async function connectionView(companyId: string, connectionId: string): Promise<ConnectionView> {
  const [view] = await listConnections(companyId, connectionId);
  if (!view) throw new ConnectionRefusal(404, 'Connection not found');
  return view;
}

/** Whether two companies are current members of one group: the definer helper, so the answer ignores the caller's RLS. */
async function inOneGroup(companyId: string, partnerId: string): Promise<boolean> {
  const rows = (await sql`SELECT public.intercompany_in_one_group(${companyId}::UUID, ${partnerId}::UUID) AS ok`) as Row[];
  return rows[0]?.ok === true;
}

/**
 * A group connection between the session company and `partnerCompanyId`. The caller needs a write role in
 * both. A revoked group connection of the pair is re-activated (its sides, and so the setup, are kept) by one
 * UPDATE ... WHERE status = 'revoked'; otherwise one is inserted and a concurrent insert is a 409.
 */
export async function createGroupConnection(userId: string, companyId: string, partnerCompanyId: string): Promise<ConnectionView> {
  if (partnerCompanyId === companyId) throw new ConnectionRefusal(400, 'A company cannot connect to itself');
  if (!(await userCanWriteCompany(userId, companyId)) || !(await userCanWriteCompany(userId, partnerCompanyId))) {
    throw new ConnectionRefusal(403, 'Connecting two companies needs an owner, admin or manager role in both.');
  }
  if (!(await inOneGroup(companyId, partnerCompanyId))) {
    throw new ConnectionRefusal(400, 'Both companies must be current members of the same company group.');
  }
  const { low, high } = orderedPair(companyId, partnerCompanyId);

  const revived = (await sql`
    UPDATE intercompany_connections SET status = 'active'
    WHERE company_low_id = ${low}::UUID AND company_high_id = ${high}::UUID AND kind = 'group' AND status = 'revoked'
    RETURNING id
  `) as Row[];
  const reactivated = revived[0];
  if (reactivated) return connectionView(companyId, String(reactivated.id));

  const created = (await sql`
    INSERT INTO intercompany_connections (company_low_id, company_high_id, kind, status, invited_by_company_id)
    VALUES (${low}::UUID, ${high}::UUID, 'group', 'active', ${companyId}::UUID)
    ON CONFLICT (company_low_id, company_high_id) WHERE status <> 'revoked' DO NOTHING
    RETURNING id
  `) as Row[];
  const inserted = created[0];
  if (!inserted) throw new ConnectionRefusal(409, 'These companies are already connected.');
  return connectionView(companyId, String(inserted.id));
}

/** Either party ends the connection. Refused when it is not this company's, or is already revoked. */
export async function revokeConnection(companyId: string, connectionId: string): Promise<ConnectionView> {
  const done = (await sql`
    UPDATE intercompany_connections SET status = 'revoked'
    WHERE id = ${connectionId}::UUID
      AND (company_low_id = ${companyId}::UUID OR company_high_id = ${companyId}::UUID)
      AND status <> 'revoked'
    RETURNING id
  `) as Row[];
  if (!done[0]) {
    await connectionView(companyId, connectionId);
    throw new ConnectionRefusal(409, 'This connection is already revoked.');
  }
  return connectionView(companyId, connectionId);
}
