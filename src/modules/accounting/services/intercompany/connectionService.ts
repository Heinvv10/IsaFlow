/**
 * Intercompany connections (P1): create a GROUP connection, revoke one, and (connectionSideService) edit this
 * company's own side. Rules, in the service and again in the database (999p): both companies are current
 * members of one group and the caller can write in both; a revoked group connection is re-activated, never
 * duplicated; either party may revoke. Messages, accepting, pairing, loans and interest are later phases.
 */
import { sql } from '@/lib/neon';
import { userCanWriteCompany } from '@/modules/accounting/services/core/companyAccessService';
import { listConnections } from './connectionRead';
import { orderedPair } from './connectionValidation';
import { ConnectionRefusal, type ConnectionView } from './connectionTypes';

export { listConnections, listGroupCandidates } from './connectionRead';
export { updateOwnSide } from './connectionSideService';

type Row = Record<string, unknown>;

async function inOneGroup(companyId: string, partnerId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM company_group_members a
    JOIN company_group_members b ON b.group_id = a.group_id
    WHERE a.company_id = ${companyId}::UUID AND b.company_id = ${partnerId}::UUID
      AND a.left_date IS NULL AND b.left_date IS NULL
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}

/**
 * A group connection between the session company and `partnerCompanyId`. The caller needs a write role in
 * both. Re-creating over a revoked group connection re-activates it (its sides, and so the setup, are kept).
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

  const existing = (await sql`
    SELECT id, status, kind FROM intercompany_connections
    WHERE company_low_id = ${low}::UUID AND company_high_id = ${high}::UUID
  `) as Row[];
  const row = existing[0];
  if (row) {
    if (row.status !== 'revoked') throw new ConnectionRefusal(409, 'These companies are already connected.');
    if (row.kind !== 'group') throw new ConnectionRefusal(409, 'An earlier external connection between these companies was revoked; invite again.');
    await sql`UPDATE intercompany_connections SET status = 'active' WHERE id = ${String(row.id)}::UUID`;
    return (await listConnections(companyId, String(row.id)))[0]!;
  }

  const created = (await sql`
    INSERT INTO intercompany_connections (company_low_id, company_high_id, kind, status, invited_by_company_id)
    VALUES (${low}::UUID, ${high}::UUID, 'group', 'active', ${companyId}::UUID)
    ON CONFLICT (company_low_id, company_high_id) DO NOTHING
    RETURNING id
  `) as Row[];
  if (!created[0]) throw new ConnectionRefusal(409, 'These companies are already connected.');
  return (await listConnections(companyId, String(created[0].id)))[0]!;
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
    const [seen] = await listConnections(companyId, connectionId);
    if (!seen) throw new ConnectionRefusal(404, 'Connection not found');
    throw new ConnectionRefusal(409, 'This connection is already revoked.');
  }
  return (await listConnections(companyId, connectionId))[0]!;
}
