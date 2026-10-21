/**
 * What the builder refuses (blocking issues) or explains, from the review
 * findings on PR #768:
 *   M1  only Sage's own still-owed invoices are taken on as invoices;
 *   M2  foreign-currency companies, contacts and documents block;
 *   M3  the financial year must start in the same month on both sides;
 *   M4  a journal date in a closed / locked IsaFlow period names the period;
 *   M8  a customer in credit says what it does to the control account;
 *   L1  an unplaceable TB line is "already reported" only by an ACCOUNTS issue;
 *   L2  a bank whose id clashes with a non-bank account keeps both.
 */
import { describe, expect, it } from 'vitest';
import { buildSageTakeOn } from '@/modules/accounting/services/sage/sageTakeOnBuilder';
import type { TakeOnContext } from '@/modules/accounting/services/sage/sageTakeOnTypes';
import type { SagePull } from '@/modules/accounting/services/sage/sageApiTypes';
import { emptyCompany, sageFixture } from './sageFixture';

const errors = (ctx: TakeOnContext, p = sageFixture()) => buildSageTakeOn(p, ctx).issues.filter((i) => i.severity === 'error');

describe('M1: only invoices are taken on as invoices; anything else is left out with a warning', () => {
  it('the fixture, whose documents are all Sage invoices, has no issue about documents', () => {
    expect(errors(emptyCompany)).toEqual([]);
    expect(buildSageTakeOn(sageFixture(), emptyCompany).issues.some((i) => /not an unpaid/.test(i.message))).toBe(false);
  });

  // Hein, 2026-10-21: a credit note, an unallocated receipt or an opening-balance
  // entry is not one of Sage's unpaid invoices. It is left out (never taken on
  // as an invoice), the review names it and its amount, and the contact's
  // balance logic absorbs it: the balance is the truth.
  it('leaves out a document that is not one of Sage\'s unpaid tax invoices, names it and its amount, and blocks nothing', () => {
    const p = sageFixture();
    p.customerDocuments[11]!.push({ ID: 9100, DocumentTypeId: 7, DocumentNumber: 'CRN0001', Date: '2026-09-15', Total: 500, AmountDue: 500 });
    const t = buildSageTakeOn(p, emptyCompany);
    expect(errors(emptyCompany, p)).toEqual([]);
    const w = t.issues.find((i) => i.message.includes('CRN0001'))!;
    expect(w).toMatchObject({ severity: 'warning', area: 'receivables' });
    expect(w.message).toMatch(/R500\D00/);
    expect(w.message).toContain('Bright Billboards');
    expect(t.arInvoices.map((i) => i.invoiceNumber)).not.toContain('CRN0001');
    // The balance still decides: Bright Billboards owes R20 000, so the invoices still carry exactly that.
    const owed = t.arInvoices.filter((i) => i.customerName === 'Bright Billboards').reduce((s, i) => s + i.totalAmount - i.amountPaid, 0);
    expect(owed).toBeCloseTo(20000, 2);
  });

  it('matches on id AND number: an invoice id with another number is left out, and the balance comes forward instead', () => {
    const p = sageFixture();
    p.supplierDocuments[21]![0]!.DocumentNumber = 'PH-78';
    const t = buildSageTakeOn(p, emptyCompany);
    expect(t.issues).toContainEqual(expect.objectContaining({ severity: 'warning', area: 'payables', message: expect.stringContaining('PH-78') }));
    expect(t.apInvoices).toEqual([expect.objectContaining({ invoiceNumber: 'SAGE-BF-S21', totalAmount: 27000 })]);
  });
});

describe('M2: home currency only', () => {
  it('blocks a Sage company in another currency', () => {
    const p = sageFixture();
    p.company.currencySymbol = '$';
    expect(errors(emptyCompany, p)).toContainEqual(expect.objectContaining({ area: 'company', message: expect.stringContaining('$') }));
  });

  it('blocks an IsaFlow company that is not in ZAR', () => {
    expect(errors({ ...emptyCompany, homeCurrency: 'USD' })).toContainEqual(expect.objectContaining({ area: 'company', message: expect.stringContaining('USD') }));
  });

  it('blocks a contact kept in a foreign currency, and a document with an exchange rate', () => {
    const p = sageFixture();
    p.customers[0]!.CurrencySymbol = '€';
    p.supplierDocuments[21]![0]!.Supplier_ExchangeRate = 18.5;
    const e = errors(emptyCompany, p);
    expect(e).toContainEqual(expect.objectContaining({ area: 'customers', message: expect.stringContaining('Bright Billboards') }));
    expect(e).toContainEqual(expect.objectContaining({ area: 'payables', message: expect.stringContaining('18.5') }));
  });

  it('a home-currency contact and an exchange rate of 1 are fine', () => {
    const p = sageFixture();
    p.customers[0]!.CurrencySymbol = 'R';
    p.supplierDocuments[21]![0]!.Supplier_ExchangeRate = 1;
    expect(errors(emptyCompany, p)).toEqual([]);
  });
});

// R8: Sage's CurrencyId is read too, through Currency/Get, failing closed.
describe('R8: a contact\'s CurrencyId', () => {
  const withCustomer = (patch: Record<string, unknown>, currencies: SagePull['currencies'] = sageFixture().currencies) => {
    const p = sageFixture();
    Object.assign(p.customers[0]!, patch);
    p.currencies = currencies;
    return errors(emptyCompany, p);
  };

  it('a foreign CurrencyId blocks even when Sage omits the symbol and the exchange rate', () => {
    expect(withCustomer({ CurrencyId: 4 })).toContainEqual(expect.objectContaining({ area: 'customers', message: expect.stringContaining('USD') }));
  });

  it('the home currency\'s own id, 0 and null are home', () => {
    expect(withCustomer({ CurrencyId: 1 })).toEqual([]);
    expect(withCustomer({ CurrencyId: 0 })).toEqual([]);
    expect(withCustomer({ CurrencyId: null })).toEqual([]);
  });

  it('fails closed: an id the currency list does not have, or no list at all, blocks', () => {
    expect(withCustomer({ CurrencyId: 99 })).toContainEqual(expect.objectContaining({ message: expect.stringContaining('could not identify') }));
    expect(withCustomer({ CurrencyId: 1 }, null)).toContainEqual(expect.objectContaining({ area: 'customers' }));
  });

  it('a document\'s own currency id is read too', () => {
    const p = sageFixture();
    p.supplierDocuments[21]![0]!.Supplier_CurrencyId = 4;
    expect(errors(emptyCompany, p)).toContainEqual(expect.objectContaining({ area: 'payables', message: expect.stringContaining('USD') }));
  });
});

// R2: judged against IsaFlow's REAL fiscal year (the fiscal_periods year that
// holds the cut-over date), not companies.financial_year_start, which every
// company declares as 3 while its periods start on 1 January.
describe('M3 / R2: the financial year', () => {
  it('blocks when IsaFlow\'s fiscal year holding the cut-over date starts on another day than Sage\'s', () => {
    const e = errors({ ...emptyCompany, fiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31' } });
    expect(e).toContainEqual(expect.objectContaining({ area: 'company', message: expect.stringMatching(/2026-03-01.*2026-01-01/) }));
  });

  it('blocks, with what to do, when IsaFlow has no fiscal period for the cut-over date', () => {
    const e = errors({ ...emptyCompany, fiscalYear: null });
    expect(e).toContainEqual(expect.objectContaining({ area: 'company', message: expect.stringMatching(/no fiscal period covering 2026-10-21.*Fiscal Periods.*2026-03-01/) }));
  });

  it('passes when both years start on the same day', () => {
    expect(errors(emptyCompany)).toEqual([]);
  });

  it('carries the year start for the review\'s P&L note', () => {
    expect(buildSageTakeOn(sageFixture(), emptyCompany).financialYearStart).toBe('2026-03-01');
  });
});

describe('M4: closed and locked IsaFlow periods', () => {
  it('names a closed period an unpaid invoice is dated in, and says to reopen it', () => {
    const e = errors({ ...emptyCompany, closedPeriods: [{ name: 'August 2026', startDate: '2026-08-01', endDate: '2026-08-31', status: 'closed' }] });
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toMatch(/Reopen "August 2026"/);
    expect(e[0]!.message).toContain('INV0001');
  });

  it('names the period the opening balances land in', () => {
    const e = errors({ ...emptyCompany, closedPeriods: [{ name: 'October 2026', startDate: '2026-10-01', endDate: '2026-10-31', status: 'closed' }] });
    expect(e[0]!.message).toContain('the opening balances (2026-10-21)');
  });

  it('says a locked period cannot be reopened from the app', () => {
    const e = errors({ ...emptyCompany, closedPeriods: [{ name: 'FY2026 P6', startDate: '2026-08-01', endDate: '2026-08-31', status: 'locked' }] });
    expect(e[0]!.message).toMatch(/locked/);
  });

  it('ignores a closed period nothing is dated in', () => {
    expect(errors({ ...emptyCompany, closedPeriods: [{ name: 'March 2026', startDate: '2026-03-01', endDate: '2026-03-31', status: 'closed' }] })).toEqual([]);
  });
});

describe('M8: a balance on the wrong side says what it does to the control account', () => {
  it('a supplier we overpaid: Trade Payables overstated by that amount, Opening Balance Equity carries it', () => {
    const w = buildSageTakeOn(sageFixture(), emptyCompany).issues.find((i) => i.message.includes('Overpaid Media'))!;
    expect(w.severity).toBe('warning');
    expect(w.message).toMatch(/Trade Payables will be R2\D?000\D00 higher than Sage's/);
    expect(w.message).toMatch(/Opening Balance Equity carries the R2\D?000\D00 difference/);
  });
});

describe('L1 / L2: account identity', () => {
  it('an unplaceable TB line is reported even when an unrelated issue mentions the same name', () => {
    const p = sageFixture();
    // A company-area issue that quotes "Ghost", raised before the trial balance is read.
    p.company = { ...p.company, name: 'Ghost', currencySymbol: '$' };
    p.trialBalance.push({ AccountId: 4040, Name: 'Ghost', Debit: 5, Credit: 0 }, { AccountId: 2003, Name: 'Rent', Debit: 0, Credit: 5 });
    expect(errors(emptyCompany, p)).toContainEqual(expect.objectContaining({ area: 'trial_balance', message: expect.stringContaining('"Ghost"') }));
  });

  it('a bank whose id is an unrelated account\'s id keeps both, and the TB line goes by its AccountTypeId', () => {
    const p = sageFixture();
    p.bankAccounts.push({ ID: 2003, Name: 'Savings', Active: true, Balance: 0 }); // 2003 is Rent in the account list
    const t = buildSageTakeOn(p, emptyCompany);
    expect(t.accounts.map((a) => a.accountName)).toEqual(expect.arrayContaining(['Rent', 'Savings']));
    expect(t.sageBankCodes[2003]).toMatch(/^10\d\d$/);
    expect(t.sageAccountCodes[2003]).toMatch(/^60\d\d$/);

    p.trialBalance.find((l) => l.AccountId === 2003)!.AccountTypeId = 1;
    const rent = buildSageTakeOn(p, emptyCompany);
    expect(rent.openingBalances.find((b) => b.accountCode === rent.sageAccountCodes[2003])?.debit).toBe(20000);
  });

  it('refuses an id in both namespaces when the TB line does not say which', () => {
    const p = sageFixture();
    p.bankAccounts.push({ ID: 2003, Name: 'Savings', Active: true, Balance: 0 });
    expect(errors(emptyCompany, p)).toContainEqual(expect.objectContaining({ area: 'trial_balance', message: expect.stringContaining('cannot tell which') }));
  });

  // R5: the AR/AP control lines are found in the ACCOUNT namespace only; a bank
  // sharing the control's id is the bank, and its line posts as one.
  it('a bank that shares the receivable control\'s id is not taken for the control', () => {
    const p = sageFixture();
    p.bankAccounts.push({ ID: -7, Name: 'Odd Bank', Active: true, Balance: 0 });
    p.trialBalance.push({ AccountId: -7, Name: 'Odd Bank', Debit: 100, Credit: 0, AccountTypeId: 3 }, { AccountId: 2003, Name: 'Rent', Debit: 0, Credit: 100 });
    p.trialBalance.find((l) => l.AccountId === -7 && l.Name === 'Trade Receivables')!.AccountTypeId = 2;
    const t = buildSageTakeOn(p, emptyCompany);
    expect(t.totals.receivableControl).toBe(30000);
    expect(t.openingBalances.find((b) => b.accountCode === t.sageBankCodes[-7])?.debit).toBe(100);
  });
});
