/**
 * WP1 PR-A: a statement's opening and closing balance, from the WHOLE parsed file (deriveStatementBalances), what an
 * import batch may store of it (batchBalanceColumns), and the format chip's text (statementSourceLabel).
 *
 * Everything is compared in integer cents: a float chain test breaks on 0.1 + 0.2 and on large balances, and would
 * mark a good statement 'unverified'.
 */
import { describe, expect, it } from 'vitest';
import {
  batchBalanceColumns, deriveStatementBalances, statementSourceLabel,
} from '@/modules/accounting/services/bank/bankStatementBalances';
import { parseMt940Statement } from '@/modules/accounting/utils/bankMt940Parser';
import { parseOfxStatement } from '@/modules/accounting/utils/bankOfxParser';
import type { BankCsvParseResult, ParsedBankTransaction } from '@/modules/accounting/types/bank.types';

const row = (transactionDate: string, amount: number, balance?: number): ParsedBankTransaction =>
  ({ transactionDate, amount, description: `L ${transactionDate} ${amount}`, ...(balance === undefined ? {} : { balance }) });
const parse = (transactions: ParsedBankTransaction[], extra: Partial<BankCsvParseResult> = {}): BankCsvParseResult =>
  ({ transactions, errors: [], bankFormat: 'fnb', ...extra });

// Opening 1 000.00; +250.00, -100.10, +49.99 → 1 199.89.
const ASC = [row('2026-09-01', 250, 1250), row('2026-09-02', -100.1, 1149.9), row('2026-09-03', 49.99, 1199.89)];

describe('deriveStatementBalances', () => {
  it('ascending running balance: opening = first balance − first amount, closing = last balance', () => {
    expect(deriveStatementBalances(parse(ASC))).toEqual({
      source: 'running_balance', openingCents: 100000, closingCents: 119989, asAt: '2026-09-03',
    });
  });

  it('descending (newest first): opening = last balance − last amount, closing = first balance', () => {
    expect(deriveStatementBalances(parse([...ASC].reverse()))).toEqual({
      source: 'running_balance', openingCents: 100000, closingCents: 119989, asAt: '2026-09-03',
    });
  });

  it('one row proves nothing about whether its balance is before or after the line: unverified (round 2)', () => {
    expect(deriveStatementBalances(parse([row('2026-09-05', -40, 960)]))).toEqual({
      source: 'unverified', openingCents: null, closingCents: null, asAt: '2026-09-05',
    });
  });

  it('a negative (overdrawn) balance chains like any other', () => {
    const rows = [row('2026-09-01', -500, -200), row('2026-09-02', 150.25, -49.75)];
    expect(deriveStatementBalances(parse(rows))).toMatchObject({ source: 'running_balance', openingCents: 30000, closingCents: -4975 });
  });

  it('no row carries a balance: not_in_file', () => {
    expect(deriveStatementBalances(parse([row('2026-09-01', 10), row('2026-09-04', -5)]))).toEqual({
      source: 'not_in_file', openingCents: null, closingCents: null, asAt: '2026-09-04',
    });
  });

  it('some rows carry a balance and others do not: unverified', () => {
    const rows = [row('2026-09-01', 250, 1250), row('2026-09-02', -100.1), row('2026-09-03', 49.99, 1199.89)];
    expect(deriveStatementBalances(parse(rows))).toEqual({ source: 'unverified', openingCents: null, closingCents: null, asAt: '2026-09-03' });
  });

  it('a non-finite balance counts as missing', () => {
    const rows = [row('2026-09-01', 250, 1250), row('2026-09-02', -100.1, Number.NaN)];
    expect(deriveStatementBalances(parse(rows)).source).toBe('unverified');
  });

  it('a chain broken in the middle (a dropped or misread line) is unverified, in either order', () => {
    const broken = [row('2026-09-01', 250, 1250), row('2026-09-02', -100.1, 1150.9), row('2026-09-03', 49.99, 1199.89)];
    expect(deriveStatementBalances(parse(broken))).toMatchObject({ source: 'unverified', openingCents: null, closingCents: null });
    expect(deriveStatementBalances(parse([...broken].reverse())).source).toBe('unverified');
  });

  it('a printed brought-forward figure that disagrees with the derived opening is unverified; one that agrees is fine', () => {
    expect(deriveStatementBalances(parse(ASC, { openingBalance: 1000.01 })).source).toBe('unverified');
    expect(deriveStatementBalances(parse(ASC, { openingBalance: 1000 }))).toMatchObject({ source: 'running_balance', openingCents: 100000 });
  });

  it('float traps: 0.1 + 0.2 and a large balance chain exactly in cents', () => {
    // In floats 0.3 − 0.1 = 0.19999999999999998, which is not 0.2.
    const tenths = [row('2026-09-01', 0.1, 0.1), row('2026-09-02', 0.2, 0.3)];
    expect(deriveStatementBalances(parse(tenths))).toEqual({ source: 'running_balance', openingCents: 0, closingCents: 30, asAt: '2026-09-02' });
    // 282543.34 − 282543.24 = 0.1000000000349246 in floats.
    const large = [row('2026-09-01', -17456.76, 282543.24), row('2026-09-02', 0.1, 282543.34)];
    expect(deriveStatementBalances(parse(large))).toMatchObject({ source: 'running_balance', openingCents: 30000000, closingCents: 28254334 });
  });

  it('a stated closing balance (OFX) is printed, opening null unless stated, whatever the rows carry', () => {
    const ofx = [
      'OFXHEADER:100', '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>',
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260902<TRNAMT>-120.00<FITID>1<NAME>FEE</STMTTRN>',
      '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260905<TRNAMT>450.00<FITID>2<NAME>SALE</STMTTRN>',
      '</BANKTRANLIST><LEDGERBAL><BALAMT>5330.00<DTASOF>20260930</LEDGERBAL>',
      '<AVAILBAL><BALAMT>9999.99<DTASOF>20260930</AVAILBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n');
    const parsed = parseOfxStatement(ofx);
    expect(parsed.closingBalance).toBe(5330);
    expect(deriveStatementBalances(parsed)).toEqual({ source: 'printed', openingCents: null, closingCents: 533000, asAt: '2026-09-05' });
  });

  it('MT940 :60F:/:62F: are printed, signed by their D/C mark', () => {
    const mt = [
      ':20:STMT', ':25:STD/1234567890', ':60F:D260901ZAR1500,25',
      ':61:2609020902C2000,00NTRFIN//1', ':86:IN',
      ':61:2609030903D600,00NTRFOUT//2', ':86:OUT',
      ':62F:D260930ZAR100,25',
    ].join('\n');
    expect(deriveStatementBalances(parseMt940Statement(mt))).toEqual({
      source: 'printed', openingCents: -150025, closingCents: -10025, asAt: '2026-09-03',
    });
  });

  it('asAt is the latest canonical date, whatever the file order', () => {
    const rows = [row('2026-09-03', 1), row('2026-09-10', 1), row('2026-09-01', 1)];
    expect(deriveStatementBalances(parse(rows)).asAt).toBe('2026-09-10');
    expect(deriveStatementBalances(parse([])).asAt).toBeNull();
  });
});

describe('batchBalanceColumns (the write rule)', () => {
  const running = { source: 'running_balance' as const, openingCents: 100000, closingCents: 119989, asAt: '2026-09-03' };

  it('writes printed or running_balance figures when the last line is on or before the statement date', () => {
    expect(batchBalanceColumns(running, '2026-09-30')).toEqual({ openingBalance: '1000.00', closingBalance: '1199.89', balanceSource: 'running_balance' });
    expect(batchBalanceColumns(running, '2026-09-03')).toEqual({ openingBalance: '1000.00', closingBalance: '1199.89', balanceSource: 'running_balance' });
    expect(batchBalanceColumns({ source: 'printed', openingCents: null, closingCents: -10025, asAt: '2026-09-03' }, '2026-09-30'))
      .toEqual({ openingBalance: null, closingBalance: '-100.25', balanceSource: 'printed' });
  });

  it('a line after the statement date: NULL figures, unverified', () => {
    expect(batchBalanceColumns(running, '2026-09-02')).toEqual({ openingBalance: null, closingBalance: null, balanceSource: 'unverified' });
  });

  it('a statement date it cannot read as YYYY-MM-DD cannot be checked: unverified', () => {
    expect(batchBalanceColumns(running, '30/09/2026')).toEqual({ openingBalance: null, closingBalance: null, balanceSource: 'unverified' });
  });

  it('not_in_file / unverified keep their source with NULL figures; absent balances write all NULL', () => {
    expect(batchBalanceColumns({ source: 'not_in_file', openingCents: null, closingCents: null, asAt: '2026-09-03' }, '2026-09-30'))
      .toEqual({ openingBalance: null, closingBalance: null, balanceSource: 'not_in_file' });
    expect(batchBalanceColumns({ source: 'unverified', openingCents: null, closingCents: null, asAt: '2026-09-03' }, '2026-09-30'))
      .toEqual({ openingBalance: null, closingBalance: null, balanceSource: 'unverified' });
    expect(batchBalanceColumns(undefined, '2026-09-30')).toEqual({ openingBalance: null, closingBalance: null, balanceSource: null });
  });

  it('cents become exact two-decimal strings, small and negative ones included', () => {
    const c = (closingCents: number) => batchBalanceColumns({ source: 'printed', openingCents: null, closingCents, asAt: '2026-09-01' }, '2026-09-01').closingBalance;
    expect([c(5), c(-5), c(0), c(-100), c(28254334)]).toEqual(['0.05', '-0.05', '0.00', '-1.00', '282543.34']);
  });
});

describe('statementSourceLabel', () => {
  it('names the channel first, then the format; anything else upper-cased; null is Unknown format', () => {
    expect(statementSourceLabel('fnb', 'statement_ocr')).toBe('PDF (read by AI)');
    expect(statementSourceLabel(null, 'extension')).toBe('Bank feed');
    expect(statementSourceLabel(null, 'classified')).toBe('Worksheet');
    expect([
      'fnb', 'standard_bank', 'nedbank', 'absa', 'capitec', 'generic', 'ofx', 'qif', 'mt940',
    ].map((f) => statementSourceLabel(f, 'upload'))).toEqual([
      'FNB', 'Standard Bank', 'Nedbank', 'ABSA', 'Capitec', 'CSV', 'OFX', 'QIF', 'MT940',
    ]);
    expect(statementSourceLabel('investec', 'mcp')).toBe('INVESTEC');
    expect(statementSourceLabel(null, null)).toBe('Unknown format');
    expect(statementSourceLabel(null, 'upload')).toBe('Unknown format');
  });
});
