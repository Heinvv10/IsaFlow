/**
 * The VAT201 box arithmetic, as a pure function.
 *
 * WHY THIS FILE EXISTS. `vatReturnService` computes the TAX from journal lines
 * on the VAT control accounts, and then computes the SUPPLY and PURCHASE values
 * that those taxes are supposed to be 15% of from a completely different
 * population — `customer_invoices.subtotal` and `supplier_invoices.subtotal`.
 * Two populations cannot be relied on to agree, and on Velocity Fibre for
 * 2026-07-01..2026-08-31 they do not: standardRatedPurchases came back as
 * R15,401,348.82 against input tax of R1,544,575.33, which implies a base of
 * R10,297,169. SARS's own check on box 15 therefore fails by R5.1m and the
 * return cannot be filed.
 *
 * The fix is structural rather than arithmetic: derive the base from THE SAME
 * JOURNALS as the tax. The base of a VAT-bearing journal is its non-VAT,
 * non-settlement legs — for the same Velocity period that is R10,326,551.86 of
 * expense lines, and 15% of it is R1,548,982.78 against R1,544,575.33 of tax, a
 * variance of R4,407 rather than R5.1m. The residue is a real finding and is
 * reported, not smoothed away.
 *
 * Deriving base as `tax / 0.15` would make the check tie by construction and
 * prove nothing. These tests pin that the base comes from the ledger.
 */
import { describe, it, expect } from 'vitest';
import {
  SA_VAT_RATE,
  VAT_TAX_SUBTYPES,
  VAT_SETTLEMENT_SUBTYPES,
  classifyVatJournalLine,
  deriveVatBoxes,
  type VatLineInput,
} from '@/modules/accounting/services/reports/vatBoxBasis';
import {
  CASH_SUBTYPES,
  PAYABLE_SUBTYPES,
  RECEIVABLE_SUBTYPES,
  rawSubtypesFor,
} from '@/modules/accounting/services/gl/accountSubtypes';

const line = (over: Partial<VatLineInput>): VatLineInput => ({
  journalEntryId: 'je1',
  entryNumber: 'JE-1',
  entryDate: '2026-07-31',
  lineId: 'l1',
  accountId: 'a1',
  accountCode: '1000',
  accountName: 'Account',
  accountType: 'expense',
  accountSubtype: 'default_expense',
  vatType: null,
  debit: 100,
  credit: 0,
  cancelledSource: false,
  ...over,
});

describe('classifyVatJournalLine', () => {
  it('classifies a vat_input line as the input tax leg', () => {
    const c = classifyVatJournalLine(line({ accountType: 'asset', accountSubtype: 'vat_input', debit: 15, credit: 0 }));
    expect(c).toEqual({ role: 'tax', direction: 'input', amount: 15, vatType: 'standard' });
  });

  it('classifies a vat_output line as the output tax leg, credit-positive', () => {
    const c = classifyVatJournalLine(line({ accountType: 'liability', accountSubtype: 'vat_output', debit: 0, credit: 15 }));
    expect(c).toEqual({ role: 'tax', direction: 'output', amount: 15, vatType: 'standard' });
  });

  it('classifies an expense line as base', () => {
    expect(classifyVatJournalLine(line({})).role).toBe('base');
  });

  it('classifies a fixed asset line as base — capital goods bear claimable input VAT', () => {
    expect(classifyVatJournalLine(line({ accountType: 'asset', accountSubtype: 'fixed_asset' })).role).toBe('base');
  });

  it('classifies bank, cash, receivable and payable legs as settlement, never base', () => {
    for (const subtype of VAT_SETTLEMENT_SUBTYPES) {
      expect(classifyVatJournalLine(line({ accountSubtype: subtype })).role).toBe('settlement');
    }
  });

  /**
   * Round 5 review, MEDIUM-1. The membership test read the RAW
   * `account_subtype` against the four canonical tokens, so only the four
   * accounts that happened to be spelled that way reached the settlement
   * branch. Every OTHER spelling `accountSubtypes.ts` enumerates — `debtors`,
   * `trade_receivables`, `creditors`, `bank_account`, `petty_cash` — fell
   * through to `base`, where its GROSS, VAT-INCLUSIVE amount was counted as the
   * value of the supply and over-stated boxes 1 and 15 by the whole leg.
   *
   * The loop is over the vocabulary, not over a list written here: a spelling
   * added to `SUBTYPE_ALIASES` tomorrow is covered without editing this file.
   */
  it('classifies EVERY spelling of a settlement subtype as settlement, never base', () => {
    const spellings = [...new Set([...CASH_SUBTYPES, ...RECEIVABLE_SUBTYPES, ...PAYABLE_SUBTYPES])];
    // The literal four are a strict subset — otherwise this asserts nothing.
    expect(spellings.length).toBeGreaterThan(VAT_SETTLEMENT_SUBTYPES.length);
    for (const subtype of spellings) {
      const c = classifyVatJournalLine(line({ accountSubtype: subtype, debit: 115, credit: 0 }));
      expect(c.role, `subtype ${subtype}`).toBe('settlement');
    }
  });

  /**
   * Round 6 review, MEDIUM-1. A card and a sundry creditor settle an invoice
   * exactly as a bank account does, and both are offerable subtypes in the Add
   * Account dialog. Against the four-token list the GROSS leg fell through to
   * `base` and, because base is credit-less-debit on the input side, the box
   * came back NEGATIVE at exactly minus the VAT.
   */
  it('classifies a card or sundry-creditor settlement leg as settlement', () => {
    for (const token of ['credit_card', 'other_current_liability'] as const) {
      for (const subtype of rawSubtypesFor(token)) {
        expect(classifyVatJournalLine(line({ accountType: 'liability', accountSubtype: subtype })).role, subtype)
          .toBe('settlement');
      }
    }
  });

  it('reports the NET expense as the input base when a card settles the invoice', () => {
    for (const subtype of ['credit_card', 'other_current_liabilities']) {
      const boxes = deriveVatBoxes([
        line({ accountType: 'expense', accountSubtype: 'operating_expense', debit: 1000, credit: 0, vatType: 'standard' }),
        line({ lineId: 'l2', accountType: 'asset', accountSubtype: 'vat_input', debit: 150, credit: 0, vatType: 'standard' }),
        line({ lineId: 'l3', accountType: 'liability', accountSubtype: subtype, debit: 0, credit: 1150 }),
      ]);
      const input = boxes.boxes.find((b) => b.direction === 'input' && b.vatType === 'standard');
      expect(input?.base, subtype).toBeCloseTo(1000, 2);
      expect(input?.base, subtype).not.toBeCloseTo(-150, 2);
      expect(boxes.inputVariance).toBeCloseTo(0, 2);
    }
  });

  it('classifies a cancelled settlement leg by the same widened vocabulary', () => {
    for (const subtype of [...CASH_SUBTYPES, ...RECEIVABLE_SUBTYPES]) {
      expect(classifyVatJournalLine(line({ accountSubtype: subtype, cancelledSource: true })).role)
        .toBe('settlement');
    }
    // A cancelled TAX leg is still 'cancelled', whatever the case or spacing.
    expect(classifyVatJournalLine(line({ accountSubtype: 'VAT Output', cancelledSource: true })).role)
      .toBe('cancelled');
  });

  it('canonicalises case and spacing on the tax leg too', () => {
    const c = classifyVatJournalLine(
      line({ accountType: 'asset', accountSubtype: 'VAT Input', debit: 15, credit: 0 }),
    );
    expect(c).toEqual({ role: 'tax', direction: 'input', amount: 15, vatType: 'standard' });
  });

  it('still treats the GENERIC tax subtype as unmapped, not as VAT', () => {
    // `tax` canonicalises to `tax_expense`, which is NOT a VAT tax subtype.
    // Brightsphere account 34550639 "Pay As You Earn" carries it; reading it as
    // VAT pulled R23,219.01 of PAYE into box 15.
    const c = classifyVatJournalLine(
      line({ accountType: 'expense', accountSubtype: 'tax', vatType: 'standard', debit: 100, credit: 0 }),
    );
    expect(c.role).toBe('unmapped');
  });

  /**
   * Velocity Fibre account SYS-9 "VAT Payable" is a liability with a NULL
   * subtype carrying 356 posted lines and R4,917,814.24 of input tax, debited
   * on `auto_supplier_invoice` journals beside a Trade Payables credit. The
   * subtype filter in vatReturnService drops every one of them from the VAT201
   * with no signal at all. Counting it as base instead would be worse — it
   * would inflate box 15 by the tax. It is neither: it is unclassifiable, and
   * unclassifiable rows are reported.
   */
  it('classifies a VAT-coded balance-sheet line with no VAT subtype as unmapped, not base', () => {
    const c = classifyVatJournalLine(
      line({ accountType: 'liability', accountSubtype: null, accountCode: 'SYS-9', vatType: 'standard', debit: 3336.75, credit: 0 }),
    );
    expect(c.role).toBe('unmapped');
    expect(c.amount).toBe(3336.75);
  });

  it('does not treat a plain expense line carrying a vat_type as unmapped', () => {
    // 2,442 ordinary base lines on Velocity carry a vat_type. They are base.
    expect(classifyVatJournalLine(line({ vatType: 'standard' })).role).toBe('base');
  });
});

describe('deriveVatBoxes — the base comes from the ledger', () => {
  it('derives box 1 from the revenue leg of the same journal as the output tax', () => {
    const r = deriveVatBoxes([
      line({ accountType: 'asset', accountSubtype: 'receivable', debit: 115, credit: 0 }),
      line({ lineId: 'l2', accountType: 'revenue', accountSubtype: 'default_revenue', debit: 0, credit: 100 }),
      line({ lineId: 'l3', accountType: 'liability', accountSubtype: 'vat_output', debit: 0, credit: 15 }),
    ]);
    expect(r.outputBase).toBe(100);
    expect(r.outputTax).toBe(15);
    expect(r.ties).toBe(true);
  });

  it('derives box 15 from the expense leg of the same journal as the input tax', () => {
    const r = deriveVatBoxes([
      line({ accountType: 'expense', accountSubtype: 'cost_of_sales', debit: 200, credit: 0 }),
      line({ lineId: 'l2', accountType: 'asset', accountSubtype: 'vat_input', debit: 30, credit: 0 }),
      line({ lineId: 'l3', accountType: 'liability', accountSubtype: 'payable', debit: 0, credit: 230 }),
    ]);
    expect(r.inputBase).toBe(200);
    expect(r.inputTax).toBe(30);
    expect(r.ties).toBe(true);
  });

  it('does NOT derive the base from the tax — a wrong base fails the 15% check', () => {
    // The whole point. Base 500 against tax 15 must not silently become 100.
    const r = deriveVatBoxes([
      line({ accountType: 'expense', accountSubtype: 'cost_of_sales', debit: 500, credit: 0 }),
      line({ lineId: 'l2', accountType: 'asset', accountSubtype: 'vat_input', debit: 15, credit: 0 }),
    ]);
    expect(r.inputBase).toBe(500);
    expect(r.ties).toBe(false);
    expect(r.inputVariance).toBeCloseTo(15 - 75, 2);
  });

  it('splits the base across VAT types pro-rata by tax within one journal', () => {
    const r = deriveVatBoxes([
      line({ accountType: 'expense', accountSubtype: 'cost_of_sales', debit: 300, credit: 0 }),
      line({ lineId: 'l2', accountType: 'asset', accountSubtype: 'vat_input', vatType: 'standard', debit: 30, credit: 0 }),
      line({ lineId: 'l3', accountType: 'asset', accountSubtype: 'vat_input', vatType: 'capital_goods', debit: 15, credit: 0 }),
    ]);
    const std = r.boxes.find((b) => b.direction === 'input' && b.vatType === 'standard');
    const cap = r.boxes.find((b) => b.direction === 'input' && b.vatType === 'capital_goods');
    expect(std?.base).toBeCloseTo(200, 2);
    expect(cap?.base).toBeCloseTo(100, 2);
  });

  it('reports an unmapped VAT leg as excluded, with its amount, and keeps it out of every box', () => {
    const r = deriveVatBoxes([
      line({ accountType: 'expense', accountSubtype: 'cost_of_sales', debit: 22245, credit: 0 }),
      line({ lineId: 'l2', accountType: 'liability', accountSubtype: 'payable', debit: 0, credit: 25581.75 }),
      line({ lineId: 'l3', accountType: 'liability', accountSubtype: null, accountCode: 'SYS-9', vatType: 'standard', debit: 3336.75, credit: 0 }),
    ]);
    expect(r.inputTax).toBe(0);
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]).toMatchObject({ reason: 'unmapped_vat_treatment', amount: 3336.75 });
  });

  /**
   * Per-line excluded rows were the first cut and they do not survive a real
   * book: Velocity has 356 unmapped lines on ONE account and they came to 103KB
   * of near-identical rows — the same response-size defect this rewrite exists
   * to fix, reintroduced inside the completeness block. The account is also the
   * thing that has to be fixed, not each posting.
   */
  it('groups unmapped VAT by account, summing the amount and counting the lines', () => {
    const unmapped = (id: string, je: string, amt: number) =>
      line({ lineId: id, journalEntryId: je, accountId: 'sys9', accountCode: 'SYS-9', accountType: 'liability', accountSubtype: null, vatType: 'standard', debit: amt, credit: 0 });
    const r = deriveVatBoxes([
      unmapped('l1', 'je1', 3336.75),
      line({ lineId: 'l1b', journalEntryId: 'je1', accountType: 'expense', accountSubtype: 'cost_of_sales', debit: 22245, credit: 0 }),
      unmapped('l2', 'je2', 4871.1),
      line({ lineId: 'l2b', journalEntryId: 'je2', accountType: 'expense', accountSubtype: 'cost_of_sales', debit: 32474, credit: 0 }),
    ]);
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]).toMatchObject({ id: 'sys9', documentNumber: 'SYS-9', lineCount: 2 });
    expect(r.excluded[0]!.amount).toBeCloseTo(8207.85, 2);
    expect(r.excludedLineCount).toBe(2);
    expect(r.excludedAmount).toBeCloseTo(8207.85, 2);
  });

  it('flags a journal that carries tax with no base leg rather than reporting a zero base', () => {
    const r = deriveVatBoxes([
      line({ accountType: 'asset', accountSubtype: 'vat_input', debit: 15, credit: 0 }),
      line({ lineId: 'l2', accountType: 'asset', accountSubtype: 'bank', debit: 0, credit: 15 }),
    ]);
    expect(r.entriesWithoutBase).toEqual(['je1']);
    expect(r.inputTax).toBe(15);
    expect(r.ties).toBe(false);
  });

  it('reproduces the Velocity Fibre 2026-07/08 shape: R10,326,551.86 base against R1,544,575.33 tax', () => {
    const r = deriveVatBoxes([
      line({ accountType: 'expense', accountSubtype: 'default_expense', debit: 10326551.86, credit: 0 }),
      line({ lineId: 'l2', accountType: 'asset', accountSubtype: 'vat_input', debit: 1544575.33, credit: 0 }),
      line({ lineId: 'l3', accountType: 'liability', accountSubtype: 'payable', debit: 0, credit: 11871127.19 }),
    ]);
    expect(r.inputBase).toBeCloseTo(10326551.86, 2);
    // 15% of the LEDGER base, not of the R15,401,348.82 invoice subtotal.
    expect(r.inputImpliedTax).toBeCloseTo(1548982.78, 2);
    expect(r.inputVariance).toBeCloseTo(-4407.45, 2);
  });

  /**
   * Brightsphere account 34550639 "Pay As You Earn" is an EXPENSE account with
   * `account_subtype = 'tax'`. `tax` is the generic subtype for PAYE, income
   * tax and the rest — it is not a VAT control account, and reading it as one
   * pulled R23,219.01 of PAYE into box 15 for 2026-07/08. A VAT control account
   * is `vat_input` or `vat_output`; nothing else is, and picking accounts by a
   * loose bucket is the same mistake as picking cost of sales by account name.
   */
  it('does not treat account_subtype "tax" as a VAT control account', () => {
    const c = classifyVatJournalLine(
      line({ accountCode: '34550639', accountName: 'Pay As You Earn', accountType: 'expense', accountSubtype: 'tax', vatType: null, debit: 23219.01, credit: 0 }),
    );
    expect(c.role).not.toBe('tax');
    const r = deriveVatBoxes([
      line({ accountCode: '34550639', accountType: 'expense', accountSubtype: 'tax', debit: 23219.01, credit: 0 }),
      line({ lineId: 'l2', accountType: 'asset', accountSubtype: 'bank', debit: 0, credit: 23219.01 }),
    ]);
    expect(r.inputTax).toBe(0);
    expect(r.boxes).toHaveLength(0);
  });

  it('reports a VAT-coded "tax" account as unmapped rather than dropping it', () => {
    // A genuine VAT account mistyped as `tax` must not vanish because of the
    // rule above. If it carries a VAT code, it is reported.
    const c = classifyVatJournalLine(
      line({ accountType: 'liability', accountSubtype: 'tax', vatType: 'standard', debit: 0, credit: 500 }),
    );
    expect(c.role).toBe('unmapped');
    expect(c.amount).toBe(500);
  });

  /**
   * Brightsphere carries a CANCELLED customer invoice whose journal is still
   * posted, and R3,750 of output VAT with it. The invoice is cancelled, so the
   * tax is not due; the journal is posted, so the GL has it anyway. Netting it
   * silently out of box 1 would make the return disagree with the VAT control
   * account with nothing to say why, and leaving it in overstates what SARS is
   * owed. It comes out of the box AND is named, with its amount, so the reader
   * can see both the filable figure and the credit note that still has to be
   * posted.
   */
  it('takes the tax of a cancelled document out of the boxes and names it', () => {
    const r = deriveVatBoxes([
      line({ accountType: 'asset', accountSubtype: 'receivable', debit: 28750, credit: 0, cancelledSource: true }),
      line({ lineId: 'l2', accountType: 'revenue', accountSubtype: 'default_revenue', debit: 0, credit: 25000, cancelledSource: true }),
      line({ lineId: 'l3', accountType: 'liability', accountSubtype: 'vat_output', debit: 0, credit: 3750, cancelledSource: true }),
    ]);
    expect(r.outputTax).toBe(0);
    expect(r.outputBase).toBe(0);
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]).toMatchObject({ reason: 'cancelled_document', amount: 3750, documentNumber: 'JE-1' });
  });

  it('exposes the rate and the tax subtypes it recognises', () => {
    expect(SA_VAT_RATE).toBe(0.15);
    expect([...VAT_TAX_SUBTYPES]).toEqual(['vat_input', 'vat_output']);
  });
});
