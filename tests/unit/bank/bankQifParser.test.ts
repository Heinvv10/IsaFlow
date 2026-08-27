// tests/unit/bank/bankQifParser.test.ts
//
// QIF (Quicken Interchange Format) parser. Regression cover for the
// header-block bug: a `!Type:Bank` header shares the first `^`-delimited
// block with the FIRST transaction, so filtering out blocks that start with
// `!` silently dropped record #1 of every real bank export.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseQifStatement } from '@/modules/accounting/utils/bankQifParser';

const FIXTURE = readFileSync(join(__dirname, '../../fixtures/bank/sample.qif'), 'utf8');

describe('parseQifStatement', () => {
  it('keeps the first record when the file has a !Type header and CRLF endings', () => {
    const result = parseQifStatement(FIXTURE);

    expect(result.errors).toEqual([]);
    expect(result.transactions).toHaveLength(3);

    const first = result.transactions[0]!;
    expect(first.transactionDate).toBe('2026-03-01');
    expect(first.amount).toBe(-1234.56);
    expect(first.description).toBe('WOOLWORTHS SANDTON');
    expect(first.reference).toBe('POS001');

    expect(result.transactions[1]!.transactionDate).toBe('2026-03-02');
    expect(result.transactions[1]!.amount).toBe(25000);
    expect(result.transactions[2]!.amount).toBe(-99);
  });

  it('parses a headerless QIF with LF endings', () => {
    const content = ['D01/03/2026', 'T-10.00', 'PFEE', '^', 'D02/03/2026', 'T20.00', 'PDEPOSIT', '^'].join('\n');
    const result = parseQifStatement(content);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]!.description).toBe('FEE');
  });

  it('ignores !Account / !Type header blocks that stand alone', () => {
    const content = '!Type:Bank\n^\nD05/03/2026\nT1.50\nPINTEREST\n^\n';
    const result = parseQifStatement(content);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.transactionDate).toBe('2026-03-05');
  });

  it('reports an error rather than a transaction when a record has no date', () => {
    const content = '!Type:Bank\nT-10.00\nPNODATE\n^\n';
    const result = parseQifStatement(content);
    expect(result.transactions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });
});
