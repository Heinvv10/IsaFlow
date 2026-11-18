/**
 * The pair's agreement on one connection: settlement mode, cut-over date, interest rate. One value for both
 * companies, so a GROUP connection's changes need a write role in BOTH companies (the database re-checks it).
 */
import { sql } from '@/lib/neon';
import { userCanWriteCompany } from '@/modules/accounting/services/core/companyAccessService';
import { listConnections } from './connectionRead';
import { ConnectionRefusal, type ConnectionView, type PairInput } from './connectionTypes';

type Row = Record<string, unknown>;

export async function updateConnectionSettings(userId: string, companyId: string, connectionId: string, input: PairInput): Promise<ConnectionView> {
  const [conn] = await listConnections(companyId, connectionId);
  if (!conn) throw new ConnectionRefusal(404, 'Connection not found');
  if (conn.status === 'revoked') throw new ConnectionRefusal(409, 'This connection is revoked; its settings can no longer change.');
  if (conn.kind !== 'group') throw new ConnectionRefusal(400, 'The settings of an external connection are agreed in its invitation.');
  if (!(await userCanWriteCompany(userId, companyId)) || !(await userCanWriteCompany(userId, conn.partnerCompanyId))) {
    throw new ConnectionRefusal(403, "Changing the connection's settings needs an owner, admin or manager role in both companies.");
  }

  const pick = <K extends keyof PairInput>(k: K, stored: PairInput[K]): PairInput[K] => (k in input ? input[k] : stored);
  const mode = pick('settlementMode', conn.settings.settlementMode) ?? 'cash';
  const cutover = pick('cutoverDate', conn.settings.cutoverDate) ?? null;
  const interest = pick('interestRatePct', conn.settings.interestRatePct) ?? null;
  const done = (await sql`
    UPDATE intercompany_connections
       SET settlement_mode = ${mode}, cutover_date = ${cutover}::DATE, interest_rate_pct = ${interest}::NUMERIC
     WHERE id = ${connectionId}::UUID AND status <> 'revoked'
    RETURNING id
  `) as Row[];
  if (!done[0]) throw new ConnectionRefusal(409, 'This connection was revoked while you were editing it.');
  const [view] = await listConnections(companyId, connectionId);
  if (!view) throw new ConnectionRefusal(404, 'Connection not found');
  return view;
}
