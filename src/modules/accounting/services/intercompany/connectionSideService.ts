/**
 * Edit THIS company's side of a connection (customer, supplier, loan account, default expense account,
 * auto-accept). A company never touches its partner's side: the row is keyed by (connection, session company),
 * RLS refuses any other, and every referenced customer, supplier and account must be this company's own.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { customerBelongsToCompany, supplierBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { isHeaderSql } from '@/modules/accounting/services/budgets/headerSql';
import { listConnections } from './connectionRead';
import { autoAcceptRefusal } from './connectionValidation';
import { ConnectionRefusal, type ConnectionView, type SideInput } from './connectionTypes';

type Row = Record<string, unknown>;

let sideSeq = 0;

/** An active, non-header (postable) account of this company. */
async function postableAccountOf(companyId: string, accountId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM gl_accounts ga
    WHERE ga.id = ${accountId}::UUID AND ga.company_id = ${companyId}::UUID AND ga.is_active = true
      AND NOT ${isHeaderSql()}
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}

/** Throws the refusal for the first reference that is not this company's. Nothing is written before it. */
async function refuseForeignRefs(companyId: string, input: SideInput): Promise<void> {
  if (input.customerId && !(await customerBelongsToCompany(companyId, input.customerId))) {
    throw new ConnectionRefusal(400, 'That customer was not found for this company.');
  }
  if (input.supplierId && !(await supplierBelongsToCompany(companyId, input.supplierId))) {
    throw new ConnectionRefusal(400, 'That supplier was not found for this company.');
  }
  if (input.loanAccountId && !(await postableAccountOf(companyId, input.loanAccountId))) {
    throw new ConnectionRefusal(400, 'The loan account must be an active, postable account of this company.');
  }
  if (input.defaultExpenseAccountId && !(await postableAccountOf(companyId, input.defaultExpenseAccountId))) {
    throw new ConnectionRefusal(400, 'The default expense account must be an active, postable account of this company.');
  }
}

/** The side after the change: what was stored, with each key the caller sent applied (null clears). */
function merged(current: ConnectionView['side'], input: SideInput) {
  const pick = <K extends keyof SideInput>(k: K, stored: SideInput[K]): SideInput[K] => (k in input ? input[k] : stored);
  return {
    customerId: pick('customerId', current?.customerId ?? null) ?? null,
    supplierId: pick('supplierId', current?.supplierId ?? null) ?? null,
    loanAccountId: pick('loanAccountId', current?.loanAccountId ?? null) ?? null,
    defaultExpenseAccountId: pick('defaultExpenseAccountId', current?.defaultExpenseAccountId ?? null) ?? null,
    autoAccept: pick('autoAccept', current?.autoAccept ?? false) ?? false,
  };
}

/** A customer or supplier already linked on another connection of this company (the unique indexes of 999p). */
function linkedElsewhere(err: unknown): ConnectionRefusal | null {
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return null;
  if (e.constraint === 'intercompany_sides_customer_uq') return new ConnectionRefusal(409, 'That customer is already linked to another intercompany connection.');
  if (e.constraint === 'intercompany_sides_supplier_uq') return new ConnectionRefusal(409, 'That supplier is already linked to another intercompany connection.');
  return null;
}

export async function updateOwnSide(companyId: string, connectionId: string, input: SideInput): Promise<ConnectionView> {
  const [conn] = await listConnections(companyId, connectionId);
  if (!conn) throw new ConnectionRefusal(404, 'Connection not found');
  if (conn.status === 'revoked') throw new ConnectionRefusal(409, 'This connection is revoked; its settings can no longer change.');
  const refusal = autoAcceptRefusal(conn.kind, input.autoAccept);
  if (refusal) throw new ConnectionRefusal(400, refusal);
  await refuseForeignRefs(companyId, input);

  const next = merged(conn.side, input);
  try {
    // A savepoint: a refused write must not poison the request's transaction.
    await withSavepoint(`ic_side_${++sideSeq}`, async () => sql`
      INSERT INTO intercompany_connection_sides
        (connection_id, company_id, partner_company_id, customer_id, supplier_id, loan_account_id,
         default_expense_account_id, auto_accept)
      VALUES (${connectionId}::UUID, ${companyId}::UUID, ${conn.partnerCompanyId}::UUID, ${next.customerId}::UUID,
              ${next.supplierId}::UUID, ${next.loanAccountId}::UUID, ${next.defaultExpenseAccountId}::UUID, ${next.autoAccept})
      ON CONFLICT (connection_id, company_id) DO UPDATE SET
        customer_id = EXCLUDED.customer_id, supplier_id = EXCLUDED.supplier_id, loan_account_id = EXCLUDED.loan_account_id,
        default_expense_account_id = EXCLUDED.default_expense_account_id, auto_accept = EXCLUDED.auto_accept
    `);
  } catch (err) {
    const known = linkedElsewhere(err);
    if (known) throw known;
    throw err;
  }
  const [view] = await listConnections(companyId, connectionId);
  if (!view) throw new ConnectionRefusal(404, 'Connection not found');
  return view;
}
