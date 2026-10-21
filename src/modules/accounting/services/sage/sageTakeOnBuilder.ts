/**
 * Turns one Sage pull into a complete, self-checking migration take-on:
 * chart of accounts + role map, opening trial balance (without the AR/AP
 * control lines), customers, suppliers and their outstanding documents.
 *
 * Pure. The pull service supplies the data, the import service supplies the
 * company's current chart (TakeOnContext) and runs the result through the
 * migration wizard's own steps, so the Sage route and the file route post
 * through the same tested engine.
 */
import { buildAccounts, buildOpeningBalances } from './sageTakeOnAccounts';
import { buildContacts, type TakeOnContact, type TakeOnDocument } from './sageTakeOnContacts';
import type { SagePull } from './sageApiTypes';
import { formatRand, round2, type SageTakeOn, type TakeOnContext, type TakeOnIssue } from './sageTakeOnTypes';

export type { TakeOnContext } from './sageTakeOnTypes';

const contactRow = ({ sageId: _sageId, ...rest }: TakeOnContact) => rest;

const docRow = <K extends 'customerName' | 'supplierName'>(key: K, d: TakeOnDocument) => {
  const { contactName, ...rest } = d;
  return { ...rest, [key]: contactName } as Omit<TakeOnDocument, 'contactName'> & Record<K, string>;
};

function reconcile(
  issues: TakeOnIssue[], area: 'receivables' | 'payables', control: number, documents: number,
): void {
  const gap = round2(control - documents);
  if (Math.abs(gap) <= 0.01) return;
  const what = area === 'receivables' ? 'customer' : 'supplier';
  issues.push({
    severity: 'warning',
    area,
    message: `Sage's ${area === 'receivables' ? 'Trade Receivables' : 'Trade Payables'} is ${formatRand(control)} but the ${what} balances that can be taken on come to ${formatRand(documents)} (difference ${formatRand(gap)}). The difference stays on Opening Balance Equity until you capture the ${what} items listed above.`,
  });
}

export function buildSageTakeOn(pull: SagePull, ctx: TakeOnContext): SageTakeOn {
  const issues: TakeOnIssue[] = [];
  const accounts = buildAccounts(pull, ctx, issues);
  const opening = buildOpeningBalances(pull, accounts, issues);
  const customers = buildContacts(pull.customers, pull.customerDocuments, 'customer', pull.asAtDate, issues);
  const suppliers = buildContacts(pull.suppliers, pull.supplierDocuments, 'supplier', pull.asAtDate, issues);

  reconcile(issues, 'receivables', opening.receivableControl, customers.documentsTotal);
  reconcile(issues, 'payables', opening.payableControl, suppliers.documentsTotal);

  return {
    sageCompany: pull.company,
    asAtDate: pull.asAtDate,
    accounts: accounts.accounts,
    systemAccountMap: accounts.systemAccountMap,
    sageAccountCodes: accounts.sageAccountCodes,
    openingBalances: opening.openingBalances,
    openingBalanceClearing: opening.openingBalanceClearing,
    customers: customers.contacts.map(contactRow),
    suppliers: suppliers.contacts.map(({ sageId: _s, creditLimit: _c, ...rest }) => rest),
    arInvoices: customers.documents.map((d) => docRow('customerName', d)),
    apInvoices: suppliers.documents.map((d) => docRow('supplierName', d)),
    issues,
    totals: {
      trialBalanceDebit: opening.trialBalanceDebit,
      trialBalanceCredit: opening.trialBalanceCredit,
      receivableControl: opening.receivableControl,
      receivableDocuments: customers.documentsTotal,
      payableControl: opening.payableControl,
      payableDocuments: suppliers.documentsTotal,
    },
  };
}
