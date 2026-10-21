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
    // Round 4: its effect is already in the balance that comes across; capturing it again double-counts.
    expect(w.message).toMatch(/already included in Bright Billboards's Sage balance/);
    expect(w.message).toMatch(/do not capture it again/i);
    expect(w.message).not.toMatch(/allocate (it|the item)/i);
    expect(t.arInvoices.map((i) => i.invoiceNumber)).not.toContain('CRN0001');
    // The balance still decides: Bright Billboards owes R20 000, so the invoices still carry exactly that.
    const owed = t.arInvoices.filter((i) => i.customerName === 'Bright Billboards').reduce((s, i) => s + i.totalAmount - i.amountPaid, 0);
    expect(owed).toBeCloseTo(20000, 2);
  });

  // Round 4: a document Sage lists with nothing (or less than nothing) due was
  // dropped silently; it is named like any other left-out document.
  it.each([['a negative amount due (a credit)', -500], ['nothing due', 0]])('names a document with %s, even one on the invoice list', (_n, due) => {
    const p = sageFixture();
    p.customerDocuments[11]!.push({ ID: 9300, DocumentNumber: 'INV0009', Date: '2026-08-01', Total: 12000, AmountDue: due });
    p.customerInvoices.push({ ID: 9300, DocumentNumber: 'INV0009' });
    p.customerDocuments[11]!.push({ ID: 9200, DocumentNumber: 'RC-9', Date: '2026-09-20', Total: 500, AmountDue: due });
    const t = buildSageTakeOn(p, emptyCompany);
    expect(t.arInvoices.map((i) => i.invoiceNumber)).not.toContain('INV0009');
    for (const n of ['RC-9', 'INV0009']) {
      expect(t.issues).toContainEqual(expect.objectContaining({ severity: 'warning', area: 'receivables', message: expect.stringMatching(new RegExp(`^${n} .*already included`)) }));
    }
    expect(t.arInvoices.filter((i) => i.customerName === 'Bright Billboards').reduce((x, i) => x + i.totalAmount - i.amountPaid, 0)).toBeCloseTo(20000, 2);
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

  // Round 5: a fully settled document says nothing about a balance; its
  // currency must not block the import. One with an amount due still does.
  it('a settled (zero-due) foreign-currency document is left out with a warning, not a block; a negative amount due still blocks', () => {
    const p = sageFixture();
    p.customerDocuments[11]!.push({ ID: 9400, DocumentNumber: 'USD-1', Date: '2026-08-01', Total: 100, AmountDue: 0, Customer_CurrencyId: 4, Customer_ExchangeRate: 18.5 });
    const t = buildSageTakeOn(p, emptyCompany);
    expect(t.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(t.issues).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringMatching(/^USD-1 /) }));
    p.customerDocuments[11]![2]!.AmountDue = -50;
    expect(errors(emptyCompany, p)).toContainEqual(expect.objectContaining({ area: 'receivables', message: expect.stringContaining('USD-1') }));
  });

  it('a single-currency company (empty list): null and 0 pass, any other id still fails closed', () => {
    expect(withCustomer({ CurrencyId: null }, [])).toEqual([]);
    expect(withCustomer({ CurrencyId: 0 }, [])).toEqual([]);
    expect(withCustomer({ CurrencyId: 1 }, [])).toContainEqual(expect.objectContaining({ area: 'customers', message: expect.stringContaining('could not identify') }));
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
  // Round 4 (Hein): a different year start no longer blocks. The opening TB is
  // taken on balance-sheet-only: this year's Sage profit to date goes into
  // Retained Earnings at the cut-over date, so IsaFlow shows no P&L before it.
  // Fixture: income 60 000, bank charges 2 000, rent 20 000 => profit 38 000;
  // Sage's Retained Income is a debit of 15 000.
  const janDec = { ...emptyCompany, fiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31' } };
  const typeOf = (t: ReturnType<typeof buildSageTakeOn>, code: string) => t.accounts.find((a) => a.accountCode === code)?.accountType;

  it('a different year start does not block: the P&L to date folds into Retained Earnings and the TB still balances', () => {
    expect(errors(janDec)).toEqual([]);
    const t = buildSageTakeOn(sageFixture(), janDec);
    expect(t.openingBalances.filter((b) => ['revenue', 'expense'].includes(typeOf(t, b.accountCode) ?? ''))).toEqual([]);
    const re = t.openingBalances.filter((b) => b.accountCode === t.systemAccountMap.retained_earnings);
    expect(re).toHaveLength(1);
    expect(re[0]!.credit - re[0]!.debit).toBeCloseTo(23000, 2); // prior equity -15 000 + profit 38 000
    const dr = t.openingBalances.reduce((x, b) => x + b.debit, 0) + t.openingBalanceClearing.debit;
    const cr = t.openingBalances.reduce((x, b) => x + b.credit, 0) + t.openingBalanceClearing.credit;
    expect(dr).toBeCloseTo(cr, 2);
    expect(t.openingBalanceClearing).toEqual(buildSageTakeOn(sageFixture(), emptyCompany).openingBalanceClearing);
    expect(t.profitAndLossFold).toEqual({ profit: 38000, isaflowYearStart: '2026-01-01', isaflowYearEnd: '2026-12-31' });
  });

  // Round 6: dividends are equity, not P&L. The fold removes only income and
  // expense lines, so a dividends account comes across on the fold path exactly
  // as on the matching one, and both SOCE readers show it as dividends.
  it('a dividends account is not folded: its line comes across, and only income and expense move to Retained Earnings', () => {
    const p = sageFixture();
    p.accounts.push({ ID: 2010, Name: 'Dividends Paid', Category: { ID: 9, Description: 'Owners Equity' }, Active: true, AccountType: 1 });
    p.trialBalance.push({ AccountId: 2010, Name: 'Dividends Paid', Debit: 10000, Credit: 0 });
    p.trialBalance.find((l) => l.AccountId === 2005)!.Credit = 19000; // share capital, to keep Sage's TB balanced
    const t = buildSageTakeOn(p, janDec);
    const dividends = t.openingBalances.find((b) => b.accountCode === t.sageAccountCodes[2010]);
    expect(dividends).toEqual({ accountCode: t.sageAccountCodes[2010], debit: 10000, credit: 0 });
    expect(t.profitAndLossFold?.profit).toBeCloseTo(38000, 2);
    const re = t.openingBalances.find((b) => b.accountCode === t.systemAccountMap.retained_earnings)!;
    expect(re.credit - re.debit).toBeCloseTo(23000, 2);
  });

  it('a loss to date folds the same way', () => {
    const p = sageFixture();
    p.trialBalance.find((l) => l.AccountId === 2003)!.Debit = 70000; // rent 70 000: a loss of 12 000
    p.trialBalance.find((l) => l.AccountId === 2005)!.Credit = 59000; // keep Sage's TB balanced
    const t = buildSageTakeOn(p, janDec);
    expect(t.profitAndLossFold?.profit).toBeCloseTo(-12000, 2);
    const re = t.openingBalances.find((b) => b.accountCode === t.systemAccountMap.retained_earnings)!;
    expect(re.debit - re.credit).toBeCloseTo(27000, 2); // debit 15 000 + loss 12 000
  });

  it('when the years match, the P&L lines come across as before and nothing is folded', () => {
    const t = buildSageTakeOn(sageFixture(), emptyCompany);
    expect(t.profitAndLossFold).toBeNull();
    expect(t.openingBalances.some((b) => typeOf(t, b.accountCode) === 'revenue')).toBe(true);
  });

  it('blocks, with what to do, when IsaFlow has no fiscal period for the cut-over date', () => {
    const e = errors({ ...emptyCompany, fiscalYear: null });
    expect(e).toContainEqual(expect.objectContaining({ area: 'company', message: expect.stringMatching(/no fiscal period covering 2026-10-21.*Create the financial year that holds 2026-10-21 under Accounting → Fiscal Periods/) }));
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
