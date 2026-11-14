/**
 * The statement side of `party_ledger_check`: the closing balance from the
 * statement services, and each statement line keyed by the document behind it.
 */
import { fetchStatementData } from '../ar/statementEmailService';
import { fetchSupplierStatementData } from '../ap/supplierStatementService';
import type { PartyType } from './partyLedgerTypes';

export interface StatementView {
  name: string;
  balance: number;
  effects: Map<string, number>;
  excluded: Map<string, string>;
}

/** Null when the party is not in this company -- never a distinct reply. */
export async function readStatement(
  companyId: string, partyType: PartyType, partyId: string, asAt: string,
): Promise<StatementView | null> {
  const isCustomer = partyType === 'customer';
  const data = isCustomer
    ? await fetchStatementData(companyId, partyId, asAt)
    : await fetchSupplierStatementData(companyId, partyId, asAt);
  if (!data) return null;
  const effects = new Map<string, number>();
  for (const t of data.transactions) {
    if (!t.documentId) continue;
    // Customer: invoices are debits, receipts and credit notes credits. Supplier: the mirror.
    const effect = isCustomer ? t.debit - t.credit : t.credit - t.debit;
    effects.set(t.documentId, (effects.get(t.documentId) ?? 0) + effect);
  }
  return {
    name: 'customer' in data ? data.customer.name : data.supplier.name,
    balance: data.summary.balance,
    effects,
    excluded: new Map(data.excluded.map((e) => [e.id, e.reason])),
  };
}

export function statementFields(view: StatementView, id: string, noStatementReason: string) {
  const effect = view.effects.get(id);
  if (effect !== undefined) return { statementEffect: effect, onStatement: true, excludedReason: null };
  return { statementEffect: 0, onStatement: false, excludedReason: view.excluded.get(id) ?? noStatementReason };
}
