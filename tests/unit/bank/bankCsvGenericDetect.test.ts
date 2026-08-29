/**
 * A plain `Date,Description,Amount,Balance` CSV must import.
 *
 * The layout every SA bank's "export to CSV" button produces was the ONE layout
 * `detectBankFormat` did not recognise: every branch required either an
 * "Account Number" column (ABSA), a debit/credit column PAIR (Standard Bank,
 * Nedbank, Capitec), or FNB's quoted headers. A four-column date/description/
 * amount/balance file matched nothing, so `parseStatement` threw
 * "Unable to detect bank format. Please specify the bank."
 *
 * There is no bank picker in the import UI (pages/accounting/bank-transactions/
 * new.tsx), so that instruction could not be followed: the file was simply
 * unimportable through the web app.
 *
 * The parsing was never the problem. ABSA's parser is header-mapped, not
 * positional, and reads this layout correctly — the three real statements in
 * test-docs/bank-statements parse to 38/497/396 transactions with the right
 * dates and signed amounts. Only detection was missing, so this adds a
 * `generic` format that maps the same way and claims the layout by name.
 *
 * The second defect is the one that actually corrupts a migration: picking the
 * WRONG bank did not fail. FNB, Standard Bank, Nedbank and Capitec each return
 * zero transactions on a file whose columns they do not recognise — and a
 * zero-transaction parse used to be reported as a successful import. A user who
 * guessed wrong got a clean "imported" of nothing. A file with data rows that
 * yields no transactions now throws.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  detectBankFormat,
  parseGenericStatement,
  parseFNBStatement,
  parseCapitecStatement,
} from '@/modules/accounting/utils/bankCsvParsers';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';
import { StatementNotImportableError } from '@/modules/accounting/services/bank/bankStatementImportErrors';

/** Real ABSA exports kept in the repo — the files that reproduced the bug. */
const REAL = [
  { path: 'test-docs/bank-statements/stmt_2018_09-12.csv', count: 38 },
  { path: 'test-docs/bank-statements/stmt_2021_10-12.csv', count: 497 },
  { path: 'test-docs/bank-statements/stmt_2022_02-03.csv', count: 396 },
];

const PLAIN = [
  'Date,Description,Amount,Balance',
  '20220201,MONTHLY ACC FEE,-85,32186.5',
  '20220202,EFT REC SOMEONE,1200.00,33386.50',
].join('\n');

describe('detectBankFormat — the plain four-column layout', () => {
  it('claims Date,Description,Amount,Balance as generic', () => {
    expect(detectBankFormat(PLAIN)).toBe('generic');
  });

  it('detects every real statement in the repo as generic, not unknown', () => {
    for (const { path } of REAL) {
      expect(detectBankFormat(readFileSync(path, 'utf8')), path).toBe('generic');
    }
  });

  it('does not steal a file another parser already claims', () => {
    // The specific presets must keep winning: generic is the FALLBACK, and a
    // debit/credit layout parsed as a single-amount one silently loses the sign
    // on every debit.
    const capitec = [
      'Date,Description,Debit,Credit,Balance',
      '2022-02-01,MONTHLY ACC FEE,85,,32186.50',
    ].join('\n');
    expect(detectBankFormat(capitec)).toBe('capitec');

    const absa = readFileSync('tests/fixtures/bank/absa-sample.csv', 'utf8');
    expect(detectBankFormat(absa)).toBe('absa');
  });

  it('still answers unknown for a CSV with no amount column', () => {
    // Generic must not become "anything with commas in it": a file we cannot
    // read an amount out of has to fail loudly, not import zero rows.
    expect(detectBankFormat('Name,Surname,Email\nA,B,c@d.e')).toBe('unknown');
  });
});

describe('parseGenericStatement', () => {
  it('reads dates, signed amounts, description and balance', () => {
    const r = parseGenericStatement(PLAIN);
    expect(r.errors).toEqual([]);
    expect(r.transactions).toEqual([
      { transactionDate: '2022-02-01', amount: -85, description: 'MONTHLY ACC FEE', balance: 32186.5 },
      { transactionDate: '2022-02-02', amount: 1200, description: 'EFT REC SOMEONE', balance: 33386.5 },
    ]);
  });

  it('parses all three real statements end to end, dropping no row silently', () => {
    for (const { path, count } of REAL) {
      const raw = readFileSync(path, 'utf8');
      const r = parseGenericStatement(raw);
      expect(r.transactions.length, path).toBe(count);
      // Stronger than the count alone: every non-blank data row in the file is
      // accounted for as either a transaction or a reported error. A row that
      // is neither has been dropped in silence, which is the failure mode this
      // whole change exists to remove.
      const dataRows = raw.split('\n').slice(1).filter(l => l.trim() !== '').length;
      expect(r.transactions.length + r.errors.length, path).toBe(dataRows);
      // Dates must be ISO and amounts signed — the whole point of the import.
      expect(r.transactions[0]!.transactionDate, path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.transactions.some(t => t.amount < 0), path).toBe(true);
    }
  });

  it('handles quoted descriptions containing commas', () => {
    const csv = [
      'Date,Description,Amount,Balance',
      '20211008,"POS PURCHASE (4,35) CHECKERS WHALE COAST",-77.98,15234.34',
    ].join('\n');
    const r = parseGenericStatement(csv);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]!.description).toContain('CHECKERS WHALE COAST');
    expect(r.transactions[0]!.amount).toBe(-77.98);
  });
});

describe('parseStatement — a file that yields nothing is an error, not an import', () => {
  it('imports the plain layout without a bank hint', async () => {
    const r = await parseStatement({ fileType: 'csv', csvContent: PLAIN });
    expect(r.transactions).toHaveLength(2);
  });

  it('throws when the caller names the WRONG bank instead of importing zero rows', async () => {
    // This is the defect that corrupts a migration quietly. Confirm first that
    // the wrong parser really does yield nothing rather than throwing on its
    // own — the guard, not the parser, is what has to catch it.
    expect(parseFNBStatement(PLAIN).transactions).toHaveLength(0);
    expect(parseCapitecStatement(PLAIN).transactions).toHaveLength(0);

    await expect(
      parseStatement({ fileType: 'csv', csvContent: PLAIN, bankFormat: 'fnb' }),
    ).rejects.toThrow(/no transactions/i);
  });

  it('names the row errors when every data row failed to parse', async () => {
    const csv = [
      'Date,Description,Amount,Balance',
      'not-a-date,SOMETHING,-85,100',
    ].join('\n');
    await expect(parseStatement({ fileType: 'csv', csvContent: csv }))
      .rejects.toThrow(/Invalid date/);
  });

  it('still refuses a file whose format cannot be detected at all', async () => {
    await expect(
      parseStatement({ fileType: 'csv', csvContent: 'Name,Surname\nA,B' }),
    ).rejects.toThrow(/Unable to detect bank format/);
  });

  it('raises the TYPED error, so the MCP tool reports it instead of rethrowing', async () => {
    // writeBankImport.ts catches StatementNotImportableError and answers with a
    // toolError; anything else it RETHROWS, which the registry records as a
    // system failure and refunds. A bad file the agent sent is not a system
    // failure, and the agent needs the message.
    await expect(
      parseStatement({ fileType: 'csv', csvContent: PLAIN, bankFormat: 'fnb' }),
    ).rejects.toBeInstanceOf(StatementNotImportableError);
  });

  it('still imports an empty-period statement, which is not a failure', async () => {
    // A bank really can export a period in which nothing happened. Refusing it
    // would trade one misleading success for a misleading failure — only a file
    // that HAS rows and produced nothing from them is refused.
    const headerOnly = 'Date,Description,Amount,Balance';
    const r = await parseStatement({ fileType: 'csv', csvContent: headerOnly });
    expect(r.transactions).toEqual([]);

    // And with a trailing blank line, which is how a real export ends.
    const withBlank = await parseStatement({ fileType: 'csv', csvContent: `${headerOnly}\n\n` });
    expect(withBlank.transactions).toEqual([]);
  });
});
