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

  // The one-sidedness has to be FORMAT-AWARE. A CSV of an empty period really is
  // one header line, but OFX, QIF and MT940 all carry a multi-line envelope even
  // with nothing in it — so a line count alone said "has rows" for every
  // empty-period export in those three formats and refused a file that is
  // perfectly valid, telling the user to check it "is really in that format".
  it('OFX: an envelope with no STMTTRN is an empty period, not a failure', async () => {
    const ofx = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>ZAR',
      '<BANKACCTFROM><ACCTID>1234567890</BANKACCTFROM>',
      '<BANKTRANLIST><DTSTART>20260301<DTEND>20260331</BANKTRANLIST>',
      '<LEDGERBAL><BALAMT>0.00<DTASOF>20260331</LEDGERBAL>',
      '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n');
    const res = await parseStatement({ fileType: 'ofx', csvContent: ofx });
    expect(res.transactions).toEqual([]);
  });

  it('QIF: a type header with no record terminator is an empty period', async () => {
    // Multi-line on purpose: a one-line body is already exempt via the line
    // count, so it would not exercise the envelope check at all.
    const qif = ['!Option:AutoSwitch', '!Type:Bank', '!Clear:AutoSwitch'].join('\n');
    const res = await parseStatement({ fileType: 'qif', csvContent: qif });
    expect(res.transactions).toEqual([]);
  });

  it('MT940: a statement with no :61: line is an empty period', async () => {
    const mt940 = [
      ':20:K145EMPTY',
      ':25:632005/1234567890',
      ':28C:1/1',
      ':60F:C260301ZAR0,00',
      ':62F:C260331ZAR0,00',
    ].join('\n');
    const res = await parseStatement({ fileType: 'mt940', csvContent: mt940 });
    expect(res.transactions).toEqual([]);
  });

  // Adjacent case: only the envelope marker buys the exemption. A multi-line
  // body that carries neither the envelope nor a record is still the
  // wrong-file-type case the guard exists for.
  it('OFX: a multi-line body with no BANKTRANLIST is still refused', async () => {
    const notOfx = [
      'OFXHEADER:100',
      '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</STATUS></SONRS></SIGNONMSGSRSV1>',
      '</OFX>',
    ].join('\n');
    await expect(
      parseStatement({ fileType: 'ofx', csvContent: notOfx }),
    ).rejects.toBeInstanceOf(StatementNotImportableError);
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
