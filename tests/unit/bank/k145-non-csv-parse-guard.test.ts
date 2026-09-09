/**
 * K-145 — RED. `parseStatement` routes OFX, QIF and MT940 straight to their
 * parsers (bankStatementParseService.ts:58-60 on origin/master) and only the
 * CSV arms are wrapped in `requireTransactions`.
 *
 * All three non-CSV parsers return `{transactions: [], errors: []}` rather than
 * throwing when the body is not in the shape they expect
 * (bankOfxParser.ts:98-107, bankQifParser.ts:156, bankMt940Parser.ts:130), so a
 * file WITH data rows that yields nothing reaches
 * pages/api/accounting/bank-transactions-bulk-commit.ts:147 with
 * `errors.length === 0` and is reported as a clean import of zero rows — the
 * exact failure `requireTransactions` was written to stop on the CSV side.
 */
import { describe, it, expect } from 'vitest';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';
import { StatementNotImportableError } from '@/modules/accounting/services/bank/bankStatementImportErrors';

// A real FNB-shaped CSV: 6 data rows, unmistakably "a file with rows in it".
const CSV_WITH_ROWS = [
  'Date,Description,Amount,Balance',
  '2026-03-01,SALARY ACME,15000.00,15000.00',
  '2026-03-02,EFT PAYMENT VODACOM,-899.00,14101.00',
  '2026-03-03,CARD PURCHASE WOOLWORTHS,-432.10,13668.90',
  '2026-03-04,BANK CHARGES,-59.00,13609.90',
  '2026-03-05,EFT RECEIVED BLITZ,2300.00,15909.90',
  '2026-03-06,DEBIT ORDER INSURANCE,-1200.00,14709.90',
].join('\n');

describe('K-145 a non-CSV import that parses nothing must not report success', () => {
  it('CSV: the guard that exists refuses the mis-declared file', async () => {
    // Control. Proves the file really does have data rows and really does parse
    // to nothing under a wrong format, so the OFX/QIF/MT940 cases below differ
    // only in which arm of parseStatement they take.
    await expect(
      parseStatement({ fileType: 'csv', csvContent: CSV_WITH_ROWS, bankFormat: 'capitec' }),
    ).rejects.toBeInstanceOf(StatementNotImportableError);
  });

  it('OFX: a file with rows that yields no transactions is refused', async () => {
    await expect(
      parseStatement({ fileType: 'ofx', csvContent: CSV_WITH_ROWS }),
    ).rejects.toBeInstanceOf(StatementNotImportableError);
  });

  it('QIF: a file with rows that yields no transactions is refused', async () => {
    await expect(
      parseStatement({ fileType: 'qif', csvContent: CSV_WITH_ROWS }),
    ).rejects.toBeInstanceOf(StatementNotImportableError);
  });

  it('MT940: a file with rows that yields no transactions is refused', async () => {
    await expect(
      parseStatement({ fileType: 'mt940', csvContent: CSV_WITH_ROWS }),
    ).rejects.toBeInstanceOf(StatementNotImportableError);
  });

  // Adjacent case: the positive control. A real OFX body with one STMTTRN in it
  // must still come back parsed — the guard only fires when nothing was read.
  it('a real OFX body with a transaction in it still parses', async () => {
    const ofx = [
      'OFXHEADER:100',
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260302<TRNAMT>-899.00',
      '<FITID>K145-1<NAME>EFT PAYMENT VODACOM</STMTTRN>',
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n');
    const res = await parseStatement({ fileType: 'ofx', csvContent: ofx });
    expect(res.transactions.length).toBe(1);
    expect(res.transactions[0]!.amount).toBeCloseTo(-899, 2);
  });

  it('an empty-period export still succeeds on every non-CSV type', async () => {
    // The guard must stay one-sided: a header-only / single-line file is a real
    // export of a quiet period and must not be turned into a failure.
    for (const fileType of ['ofx', 'qif', 'mt940'] as const) {
      const res = await parseStatement({ fileType, csvContent: 'OFXHEADER:100' });
      expect(res.transactions).toEqual([]);
    }
  });
});
