import { describe, expect, it } from 'vitest';
import { buildSageTakeOn, type TakeOnContext } from '@/modules/accounting/services/sage/sageTakeOnBuilder';
import { validateSystemAccountMap } from '@/modules/accounting/services/core/migrationCoaRoleMap';
import { emptyCompany, sageFixture } from './sageFixture';

const freshCompany: TakeOnContext = {
  takenCodes: ['1000', '1001', '1100', '1101', '1201', '2001', '2101', '3200', '4001', '5001', '6005'],
  existingRoles: {
    bank: { code: '1001', name: 'Current Account', type: 'asset' },
    receivable: { code: '1101', name: 'Trade Debtors Control', type: 'asset' },
    payable: { code: '2001', name: 'Trade Creditors Control', type: 'liability' },
    vat_input: { code: '1201', name: 'VAT Input', type: 'asset' },
    vat_output: { code: '2101', name: 'VAT Output', type: 'liability' },
    retained_earnings: { code: '3200', name: 'Retained Earnings', type: 'equity' },
    default_revenue: { code: '4001', name: 'Product Sales', type: 'revenue' },
    default_expense: { code: '5001', name: 'Cost of Goods Sold', type: 'expense' },
    admin_expense: { code: '6005', name: 'Administrative Expenses', type: 'expense' },
  },
  homeCurrency: 'ZAR',
  fiscalYear: { startDate: '2026-03-01', endDate: '2027-02-28' },
  closedPeriods: [],
};

const codeOf = (t: ReturnType<typeof buildSageTakeOn>, sageId: number) => t.sageAccountCodes[sageId]!;
const row = (t: ReturnType<typeof buildSageTakeOn>, sageId: number) => t.accounts.find((a) => a.accountCode === codeOf(t, sageId))!;

describe('buildSageTakeOn — chart of accounts', () => {
  it('lands each Sage role account on the company\'s existing role holder, renamed to the Sage name', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    expect(codeOf(t, -7)).toBe('1101');
    expect(codeOf(t, -8)).toBe('2001');
    expect(codeOf(t, -9)).toBe('2101');
    expect(codeOf(t, -11)).toBe('3200');
    expect(codeOf(t, 1001)).toBe('1001');
    expect(row(t, -7).accountName).toBe('Trade Receivables');
  });

  it('gives a non-current liability the liability type (the id-table bug made it equity)', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    expect(row(t, 2004)).toMatchObject({ accountType: 'liability', normalBalance: 'credit', accountSubtype: 'long_term_liability' });
    expect(row(t, 2005)).toMatchObject({ accountType: 'equity' });
  });

  it('allocates new codes that collide with nothing on the chart, nor with the Opening Balance Equity codes', () => {
    const t = buildSageTakeOn(sageFixture(), { ...freshCompany, takenCodes: [...freshCompany.takenCodes, '4010', '6010'] });
    const fresh = t.accounts.filter((a) => !freshCompany.takenCodes.includes(a.accountCode)).map((a) => a.accountCode);
    expect(new Set(t.accounts.map((a) => a.accountCode)).size).toBe(t.accounts.length);
    for (const c of fresh) expect(['4010', '6010', '3300', '3310', '3320', '3390']).not.toContain(c);
    expect(codeOf(t, 2001)).toMatch(/^40\d\d$/);
    expect(codeOf(t, 2003)).toMatch(/^60\d\d$/);
  });

  it('is deterministic', () => {
    expect(buildSageTakeOn(sageFixture(), freshCompany)).toEqual(buildSageTakeOn(sageFixture(), freshCompany));
  });

  it('leaves out inactive accounts with no balance', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    expect(t.sageAccountCodes[2006]).toBeUndefined();
  });

  it('produces a complete role map the COA import accepts', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    expect(Object.keys(t.systemAccountMap).sort()).toEqual(
      ['admin_expense', 'bank', 'default_expense', 'default_revenue', 'payable', 'receivable', 'retained_earnings', 'vat_input', 'vat_output']);
    expect(validateSystemAccountMap(t.systemAccountMap as unknown as Record<string, unknown>, t.accounts)).toEqual([]);
  });

  it('creates the roles Sage has no account for when the company has no holder either', () => {
    const t = buildSageTakeOn(sageFixture(), emptyCompany);
    const vatIn = t.accounts.find((a) => a.accountCode === t.systemAccountMap.vat_input)!;
    expect(vatIn).toMatchObject({ accountName: 'VAT Input', accountType: 'asset' });
    expect(validateSystemAccountMap(t.systemAccountMap as unknown as Record<string, unknown>, t.accounts)).toEqual([]);
  });
});

describe('buildSageTakeOn — opening balances', () => {
  it('carries every trial balance line except the AR and AP control totals', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    const codes = t.openingBalances.map((b) => b.accountCode);
    expect(codes).not.toContain('1101');
    expect(codes).not.toContain('2001');
    expect(t.openingBalances.find((b) => b.accountCode === codeOf(t, 1001))).toEqual({ accountCode: '1001', debit: 50000, credit: 0 });
    expect(t.openingBalances.find((b) => b.accountCode === codeOf(t, 2004))).toEqual({ accountCode: codeOf(t, 2004), debit: 0, credit: 20000 });
  });

  it('balances only once the clearing line is added — the clearing line equals AR control minus AP control', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    const dr = t.openingBalances.reduce((s, b) => s + b.debit, 0) + t.openingBalanceClearing.debit;
    const cr = t.openingBalances.reduce((s, b) => s + b.credit, 0) + t.openingBalanceClearing.credit;
    expect(dr).toBeCloseTo(cr, 2);
    // Removing DR 30000 AR and CR 25000 AP leaves the lines 5000 short on the debit side;
    // the AR documents then CR clearing 30000 and the AP documents DR it 25000, so it nets to zero.
    expect(t.openingBalanceClearing).toEqual({ debit: 5000, credit: 0 });
  });

  it('refuses a trial balance line for an account it cannot classify', () => {
    const p = sageFixture();
    p.accounts.push({ ID: 3001, Name: 'Mystery', Category: { ID: 99, Description: 'Weird Stuff' }, Active: true, AccountType: 1 });
    p.trialBalance.push({ AccountId: 3001, Name: 'Mystery', Debit: 10, Credit: 0 }, { AccountId: 2003, Name: 'Rent', Debit: 0, Credit: 10 });
    const t = buildSageTakeOn(p, freshCompany);
    expect(t.issues).toContainEqual(expect.objectContaining({ severity: 'error', area: 'accounts', message: expect.stringContaining('Mystery') }));
  });

  it('reports an unbalanced Sage trial balance as an error', () => {
    const p = sageFixture();
    p.trialBalance[0]!.Debit = 50001;
    expect(buildSageTakeOn(p, freshCompany).issues).toContainEqual(expect.objectContaining({ severity: 'error', area: 'trial_balance' }));
  });
});

describe('buildSageTakeOn — customers, suppliers and outstanding documents', () => {
  it('takes on active contacts and contacts with a balance, not dormant ones, and drops a zero-balance duplicate name', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    expect(t.customers.map((c) => c.name)).toEqual(['Bright Billboards', 'Coastal Radio', 'Active Zero Client']);
    expect(t.suppliers.map((s) => s.name)).toEqual(['Print House', 'Overpaid Media']);
    expect(t.customers[0]).toMatchObject({ email: 'ap@bright.test', phone: '011 000 0001', vatNumber: '4000000001' });
  });

  it('applies an unallocated credit to the oldest invoice first, so documents equal the customer balance', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    const bright = t.arInvoices.filter((i) => i.customerName === 'Bright Billboards');
    expect(bright).toEqual([
      expect.objectContaining({ invoiceNumber: 'INV0001', invoiceDate: '2026-08-01', dueDate: '2026-08-31', totalAmount: 12000, amountPaid: 5000, subtotal: 10434.78, taxAmount: 1565.22 }),
      expect.objectContaining({ invoiceNumber: 'INV0002', totalAmount: 13000, amountPaid: 0, reference: 'Sept' }),
    ]);
  });

  it('brings a balance with no documents forward as one take-on document', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    expect(t.arInvoices.filter((i) => i.customerName === 'Coastal Radio')).toEqual([
      expect.objectContaining({ invoiceNumber: 'SAGE-BF-C12', invoiceDate: '2026-10-21', totalAmount: 10000, amountPaid: 0, taxAmount: 0, subtotal: 10000 }),
    ]);
  });

  it('reconciles receivable documents to the control account', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    expect(t.totals.receivableControl).toBe(30000);
    expect(t.totals.receivableDocuments).toBe(30000);
  });

  it('cannot take on a supplier debit balance as a bill: warns, names it, and shows the gap', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    expect(t.apInvoices.map((i) => i.supplierName)).toEqual(['Print House']);
    expect(t.totals.payableControl).toBe(25000);
    expect(t.totals.payableDocuments).toBe(27000);
    expect(t.issues).toContainEqual(expect.objectContaining({ severity: 'warning', area: 'suppliers', message: expect.stringContaining('Overpaid Media') }));
  });

  it('computes the subtotal from total and tax when Sage omits Exclusive', () => {
    const t = buildSageTakeOn(sageFixture(), freshCompany);
    expect(t.apInvoices[0]).toMatchObject({ totalAmount: 27000, taxAmount: 3521.74, subtotal: 23478.26 });
  });

  it('suffixes duplicate names only when both contacts carry a balance', () => {
    const p = sageFixture();
    p.suppliers[2]!.Balance = 500;
    p.supplierDocuments[23] = [];
    p.trialBalance.find((l) => l.AccountId === -8)!.Credit = 25500;
    p.trialBalance.find((l) => l.AccountId === 2003)!.Debit = 20500;
    const t = buildSageTakeOn(p, freshCompany);
    expect(t.suppliers.map((s) => s.name)).toEqual(['Print House (Sage 21)', 'Overpaid Media', 'Print House (Sage 23)']);
    expect(t.apInvoices.map((i) => i.supplierName)).toEqual(['Print House (Sage 21)', 'Print House (Sage 23)']);
  });
});
