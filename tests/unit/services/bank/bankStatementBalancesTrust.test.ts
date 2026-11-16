/**
 * WP1 PR-A review round 2: a wrong figure is never stored as printed, running_balance or ai_read. Every doubt about
 * the file makes the statement 'unverified' with no figures:
 *   1. a line the parser skipped (bad date / amount), or a PDF line whose derived amount differs from the printed one;
 *   4. a chain that reads both ways to different figures, and a one-line file;
 *   5. a balance cell that is not a plain number ("50.00 Dr", "100.00-");
 *   6. a file holding more than one account/statement, or chained MT940 statements that do not join;
 *   7. a figure the column cannot hold;
 *   2. the OCR commit's AI-read balances go through the same write rule (ocrBalanceColumns).
 */
import { describe, expect, it } from 'vitest';
import {
  batchBalanceColumns, deriveStatementBalances, ocrBalanceColumns,
} from '@/modules/accounting/services/bank/bankStatementBalances';
import {
  parseCapitecStatement, parseFNBStatement, parseGenericStatement, parseNedbankStatement, parseStandardBankStatement,
} from '@/modules/accounting/utils/bankCsvParsers';
import type { BankCsvParseResult, ParsedBankTransaction } from '@/modules/accounting/types/bank.types';

const row = (transactionDate: string, amount: number, balance?: number, printedAmount?: number): ParsedBankTransaction =>
  ({ transactionDate, amount, description: 'x', ...(balance === undefined ? {} : { balance }),
    ...(printedAmount === undefined ? {} : { printedAmount }) });
const parse = (transactions: ParsedBankTransaction[], extra: Partial<BankCsvParseResult> = {}): BankCsvParseResult =>
  ({ transactions, errors: [], bankFormat: 'generic', ...extra });
const UNVERIFIED = { source: 'unverified', openingCents: null, closingCents: null };

// True opening 1000.00, closing 1300.00.
const generic = (r1: string, r3: string) => parseGenericStatement(['Date,Description,Amount,Balance',
  r1, '2026-09-02,TWO,100.00,1200.00', r3].join('\n'));

describe('1. a skipped line makes the file unverified', () => {
  it('the reviewer repros: a bad last date, a bad first amount, a bad last amount', () => {
    const good1 = '2026-09-01,ONE,100.00,1100.00';
    const good3 = '2026-09-03,THREE,100.00,1300.00';
    for (const raw of [generic(good1, '31/31/2026,THREE,100.00,1300.00'), generic('2026-09-01,ONE,abc,1100.00', good3),
      generic(good1, '2026-09-03,THREE,abc,1300.00')]) {
      expect(raw.errors.length).toBe(1);
      expect(deriveStatementBalances(raw)).toMatchObject(UNVERIFIED);
    }
    expect(deriveStatementBalances(generic(good1, good3))).toMatchObject({ source: 'running_balance', openingCents: 100000, closingCents: 130000 });
  });

  it('for a printed balance too', () => {
    const raw = parse([row('2026-09-01', 10)], { closingBalance: 10, errors: [{ row: 2, error: 'Invalid TRNAMT amount: x' }] });
    expect(deriveStatementBalances(raw)).toMatchObject(UNVERIFIED);
  });

  it('a file with no balance anywhere is still not_in_file, errors or not', () => {
    expect(deriveStatementBalances(parse([row('2026-09-01', 10)], { errors: [{ row: 3, error: 'Invalid date' }] })).source).toBe('not_in_file');
  });

  it('a PDF line whose derived amount differs from the printed one', () => {
    const rows = [row('2026-09-01', 100, 1100, 100), row('2026-09-02', -50, 1050, 60)];
    expect(deriveStatementBalances(parse(rows))).toMatchObject(UNVERIFIED);
    expect(deriveStatementBalances(parse([row('2026-09-01', 100, 1100, 100), row('2026-09-02', -50, 1050, 50)])).source).toBe('running_balance');
  });

  it('a printed opening and closing that the lines do not add up to', () => {
    const rows = [row('2026-09-01', 100), row('2026-09-02', -40)];
    expect(deriveStatementBalances(parse(rows, { openingBalance: 1000, closingBalance: 1070 }))).toMatchObject(UNVERIFIED);
    expect(deriveStatementBalances(parse(rows, { openingBalance: 1000, closingBalance: 1060 }))).toMatchObject({ source: 'printed', closingCents: 106000 });
  });

  it('a parser that says its own balances cannot be trusted', () => {
    expect(deriveStatementBalances(parse([row('2026-09-01', 10, 10), row('2026-09-02', 5, 15)], { balancesUnverifiable: 'two accounts' })))
      .toMatchObject(UNVERIFIED);
  });
});

describe('4. a chain that reads both ways', () => {
  it('FNB newest first +100 (bal 100), −100 (bal 0): both directions hold with different figures, so unverified', () => {
    // Ascending would say 0 → 0; descending (the truth) says 100 → 100.
    expect(deriveStatementBalances(parse([row('2026-09-02', 100, 100), row('2026-09-01', -100, 0)]))).toMatchObject(UNVERIFIED);
  });
});

describe('5. a balance cell is read strictly', () => {
  const fnb = (b2: string) => parseFNBStatement(['"Date","Description","Amount","Balance","Reference"',
    '"2026/09/01","A","-50.00","-50.00","R"', `"2026/09/02","B","-50.00","${b2}","R"`].join('\n'));
  it('"Dr" or a trailing minus is not a plain number: the file is unverified, not a sign-flipped chain', () => {
    for (const cell of ['100.00 Dr', '100.00-', 'R100.00', '(100.00)', '100.00 Cr']) {
      const raw = fnb(cell);
      expect(raw.balancesUnverifiable, cell).toBeTruthy();
      expect(deriveStatementBalances(raw), cell).toMatchObject(UNVERIFIED);
    }
    // All-equal amounts with every balance a positive "Dr" figure: true 0 → −100, never 150 → 50.
    const dr = parseStandardBankStatement(['Date,Description,Debit,Credit,Balance',
      '01/09/2026,A,50.00,,50.00 Dr', '02/09/2026,B,50.00,,100.00 Dr'].join('\n'));
    expect(deriveStatementBalances(dr)).toMatchObject(UNVERIFIED);
  });

  it('plain numbers in the shapes SA exports use still read', () => {
    expect(deriveStatementBalances(fnb('-100.00'))).toMatchObject({ source: 'running_balance', openingCents: 0, closingCents: -10000 });
    const g = parseGenericStatement(['Date,Description,Amount,Balance', '2026-09-01,A,1000,"1 000,00"', '2026-09-02,B,234.5,"1,234.50"'].join('\n'));
    expect(g.balancesUnverifiable).toBeUndefined();
    expect(deriveStatementBalances(g)).toMatchObject({ source: 'running_balance', openingCents: 0, closingCents: 123450 });
  });

  it('a blank balance cell is absent, not unreadable', () => {
    expect(fnb('').balancesUnverifiable).toBeUndefined();
  });
});

describe('7. a figure the column cannot hold', () => {
  it('|cents| at or above 10^15 (NUMERIC(15,2), migration 253) is stored as unverified, never sent to overflow', () => {
    const big = { source: 'printed' as const, openingCents: null, closingCents: 1e15, asAt: '2026-09-01' };
    expect(batchBalanceColumns(big, '2026-09-30')).toEqual({ openingBalance: null, closingBalance: null, balanceSource: 'unverified' });
    expect(batchBalanceColumns({ ...big, closingCents: 1e15 - 1 }, '2026-09-30').closingBalance).toBe('9999999999999.99');
    expect(batchBalanceColumns({ ...big, closingCents: 100, openingCents: -1e15 }, '2026-09-30').balanceSource).toBe('unverified');
  });
});

describe('2. ocrBalanceColumns: the AI-read figures under the write rule', () => {
  const rows = [{ date: '2026-09-07', amount: -55 }, { date: '2026-09-20', amount: 100 }];
  const base = { periodStart: '2026-09-01', periodEnd: '2026-09-30', openingBalance: 1000, closingBalance: 1045, rows };

  it('a closing read inside a well-formed period is ai_read, with its opening', () => {
    expect(ocrBalanceColumns(base)).toEqual({ openingBalance: '1000.00', closingBalance: '1045.00', balanceSource: 'ai_read' });
    expect(ocrBalanceColumns({ ...base, openingBalance: null })).toEqual({ openingBalance: null, closingBalance: '1045.00', balanceSource: 'ai_read' });
  });

  it('no closing read: not_in_file, and an opening alone is never stored', () => {
    expect(ocrBalanceColumns({ ...base, closingBalance: null })).toEqual({ openingBalance: null, closingBalance: null, balanceSource: 'not_in_file' });
  });

  it('the reviewer repros: a line after period_end, no period_end, period_end before period_start', () => {
    const none = { openingBalance: null, closingBalance: null, balanceSource: 'unverified' };
    expect(ocrBalanceColumns({ ...base, rows: [...rows, { date: '2026-10-15', amount: 0 }] })).toEqual(none);
    expect(ocrBalanceColumns({ ...base, periodEnd: null })).toEqual(none);
    expect(ocrBalanceColumns({ ...base, periodStart: '2026-10-01' })).toEqual(none);
  });

  it('also: no period start, a line before it, a line with no readable date, lines that do not add up, an overflow', () => {
    const none = { openingBalance: null, closingBalance: null, balanceSource: 'unverified' };
    expect(ocrBalanceColumns({ ...base, periodStart: null })).toEqual(none);
    expect(ocrBalanceColumns({ ...base, rows: [{ date: '2026-08-31', amount: -55 }, rows[1]!] })).toEqual(none);
    expect(ocrBalanceColumns({ ...base, rows: [{ date: '', amount: -55 }, rows[1]!] })).toEqual(none);
    expect(ocrBalanceColumns({ ...base, closingBalance: 1046 })).toEqual(none);
    expect(ocrBalanceColumns({ ...base, openingBalance: null, closingBalance: 1e13 })).toEqual(none);
  });
});

describe('round 3: padding rows in the bank CSV layouts are skipped, a garbled row is still an error', () => {
  const fnb = (...rows: string[]) => parseFNBStatement(['"Date","Description","Amount","Balance","Reference"',
    '"2026/09/01","A","100.00","1100.00","R"', '"2026/09/02","B","-40.00","1060.00","R"', ...rows].join('\n'));
  const sb = (...rows: string[]) => parseStandardBankStatement(['Date,Description,Debit,Credit,Balance',
    '01/09/2026,A,,100.00,1100.00', '02/09/2026,B,40.00,,1060.00', ...rows].join('\n'));
  const FIGURES = { source: 'running_balance', openingCents: 100000, closingCents: 106000 };

  it('FNB: a trailing Total row and a blank line in the middle are padding: the figures are stored', () => {
    expect(deriveStatementBalances(fnb('"Total","","60.00","",""'))).toMatchObject(FIGURES);
    const blankMiddle = parseFNBStatement(['"Date","Description","Amount","Balance","Reference"',
      '"2026/09/01","A","100.00","1100.00","R"', ',,,,', '', '"2026/09/02","B","-40.00","1060.00","R"'].join('\n'));
    expect(blankMiddle.errors).toEqual([]);
    expect(deriveStatementBalances(blankMiddle)).toMatchObject(FIGURES);
  });

  it('Standard Bank (and the Nedbank / Capitec layouts beside it): a Totals or Closing balance row is padding', () => {
    expect(deriveStatementBalances(sb('Totals,,40.00,100.00,'))).toMatchObject(FIGURES);
    expect(deriveStatementBalances(sb('Closing Balance,,,,1060.00'))).toMatchObject(FIGURES);
    const ned = parseNedbankStatement(['Transaction Date,Value Date,Description,Debit,Credit,Balance',
      '2026-09-01,2026-09-01,A,,100.00,1100.00', '2026-09-02,2026-09-02,B,40.00,,1060.00', 'Total,,,40.00,100.00,'].join('\n'));
    expect(deriveStatementBalances(ned)).toMatchObject(FIGURES);
    const cap = parseCapitecStatement(['Date,Description,Debit,Credit,Balance',
      '01/09/2026,A,,100.00,1100.00', '02/09/2026,B,40.00,,1060.00', '', 'Total,,40.00,100.00,'].join('\n'));
    expect(deriveStatementBalances(cap)).toMatchObject(FIGURES);
  });

  it('a garbled transaction row is still an error, so the statement is unverified', () => {
    expect(deriveStatementBalances(fnb('"2026/13/45","C","-10.00","1050.00","R"'))).toMatchObject(UNVERIFIED);
    expect(deriveStatementBalances(sb('03/09/2026,C,ten,,1050.00'))).toMatchObject(UNVERIFIED);
    expect(deriveStatementBalances(fnb('"Totally not a date","C","-10.00","1050.00","R"'))).toMatchObject(UNVERIFIED);
  });
});

describe('round 4: pdf_read figures are stored under the same write rule', () => {
  const read = { source: 'pdf_read' as const, openingCents: 100000, closingCents: 110000, asAt: '2026-09-04' };
  it('stored with the pdf_read label when the last line is on or before the statement date', () => {
    expect(batchBalanceColumns(read, '2026-09-30')).toEqual({ openingBalance: '1000.00', closingBalance: '1100.00', balanceSource: 'pdf_read' });
  });
  it('a line after the statement date, or a figure the column cannot hold: unverified', () => {
    const none = { openingBalance: null, closingBalance: null, balanceSource: 'unverified' };
    expect(batchBalanceColumns(read, '2026-09-03')).toEqual(none);
    expect(batchBalanceColumns({ ...read, closingCents: 1e15 }, '2026-09-30')).toEqual(none);
  });
});

describe('round 5: a text-parsed PDF is never printed, even if a parser sets closingBalance', () => {
  const rows = [row('2026-09-02', -100, 900), row('2026-09-03', 250, 1150)];
  it('a stated closing that the chain agrees with: pdf_read, not printed', () => {
    expect(deriveStatementBalances(parse(rows, { closingBalance: 1150, parser: 'native' }), { textPdf: true }))
      .toMatchObject({ source: 'pdf_read', openingCents: 100000, closingCents: 115000 });
  });
  it('a stated closing the chain disagrees with: unverified', () => {
    expect(deriveStatementBalances(parse(rows, { closingBalance: 1100, parser: 'native' }), { textPdf: true })).toMatchObject(UNVERIFIED);
  });
  it('a stated closing with no running balance on the lines: unverified, not printed', () => {
    expect(deriveStatementBalances(parse([row('2026-09-02', -100)], { closingBalance: 900 }), { textPdf: true })).toMatchObject(UNVERIFIED);
  });
  it('the same raw result from a non-PDF file is still printed', () => {
    expect(deriveStatementBalances(parse(rows, { closingBalance: 1150 })).source).toBe('printed');
  });
});
