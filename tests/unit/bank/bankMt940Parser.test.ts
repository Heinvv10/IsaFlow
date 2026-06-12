// tests/unit/bank/bankMt940Parser.test.ts
//
// MT940 (SWIFT Customer Statement) parser — the format SA business/corporate
// online banking exports (Standard Bank BOL, FNB Enterprise, Nedbank business).
// Output conforms to BankCsvParseResult, same as the OFX/CSV/QIF parsers.
import { describe, it, expect } from 'vitest';
import { parseMt940Statement } from '@/modules/accounting/utils/bankMt940Parser';

const SAMPLE = [
  ':20:STMT260131',
  ':25:STD/1234567890',
  ':28C:00001/001',
  ':60F:C260101ZAR10000,00',
  ':61:2601020102D1500,50NTRFREF123//8001',
  ':86:POS PURCHASE WOOLWORTHS SANDTON',
  ':61:2601030103C25000,00NTRFSALARY//8002',
  ':86:SALARY DEPOSIT ACME PTY LTD',
  'EMPLOYER REF 9988',
  ':61:2601040104RD200,00NCHGBANKFEE//8003',
  ':86:REVERSED BANK FEE',
  ':62F:C260131ZAR33299,50',
].join('\r\n');

describe('parseMt940Statement', () => {
  it('parses account number, dates, signed amounts and descriptions', () => {
    const r = parseMt940Statement(SAMPLE);
    expect(r.bankFormat).toBe('mt940');
    expect(r.errors).toEqual([]);
    expect(r.accountNumber).toBe('1234567890');
    expect(r.transactions).toHaveLength(3);

    const [t1, t2, t3] = r.transactions;
    // Debit → negative, comma decimal → dot, :86: free text as description.
    expect(t1).toMatchObject({
      transactionDate: '2026-01-02',
      amount: -1500.5,
      description: 'POS PURCHASE WOOLWORTHS SANDTON',
      reference: 'REF123',
    });
    // Credit → positive; continuation :86: line joined with a space.
    expect(t2).toMatchObject({
      transactionDate: '2026-01-03',
      amount: 25000,
      description: 'SALARY DEPOSIT ACME PTY LTD EMPLOYER REF 9988',
      reference: 'SALARY',
    });
    // RD = reversal of a debit → net credit → positive.
    expect(t3).toMatchObject({
      transactionDate: '2026-01-04',
      amount: 200,
      description: 'REVERSED BANK FEE',
    });
  });

  it('maps the four debit/credit marks to the right sign', () => {
    const stmt = [
      ':25:9999',
      ':60F:C260101ZAR0,00',
      ':61:260101C100,00NTRFa//1',
      ':86:credit',
      ':61:260101D100,00NTRFb//2',
      ':86:debit',
      ':61:260101RC100,00NTRFc//3',
      ':86:reversal of credit',
      ':61:260101RD100,00NTRFd//4',
      ':86:reversal of debit',
    ].join('\n');
    const amounts = parseMt940Statement(stmt).transactions.map((t) => t.amount);
    expect(amounts).toEqual([100, -100, -100, 100]);
  });

  it('consumes a non-N/F/S transaction-type code so the reference is clean', () => {
    // SWIFT restricts the type-code letter to N/F/S, but some banks emit others
    // (e.g. T…). The code is mandatory, so it must be consumed, not leak into ref.
    const stmt = [':25:9999', ':61:260101C100,00TAXSpayref//bankref', ':86:tax'].join('\n');
    const t = parseMt940Statement(stmt).transactions[0]!;
    expect(t.amount).toBe(100);
    expect(t.reference).toBe('payref');
  });

  it('records an error for a malformed :61: line but keeps the good ones', () => {
    const stmt = [
      ':25:9999',
      ':61:GARBAGE-NOT-A-VALID-LINE',
      ':86:should be skipped',
      ':61:260105C50,00NTRFok//9',
      ':86:good one',
    ].join('\n');
    const r = parseMt940Statement(stmt);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]!.amount).toBe(50);
    expect(r.errors.length).toBe(1);
  });

  it('does not throw on empty or non-MT940 input', () => {
    expect(parseMt940Statement('').transactions).toEqual([]);
    const r = parseMt940Statement('just some random text\nno swift tags here');
    expect(r.transactions).toEqual([]);
    expect(r.bankFormat).toBe('mt940');
  });
});
